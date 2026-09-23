import { openTestDatabase, type TestDatabase } from '../database/testing';
import { UsersRepository } from '../users/users.repository';
import { SessionsRepository } from './sessions.repository';

describe('SessionsRepository (integration)', () => {
  let t: TestDatabase;
  const repo = new SessionsRepository();
  const users = new UsersRepository();

  beforeAll(async () => {
    t = await openTestDatabase();
  });
  beforeEach(() => t.truncate('users', 'sessions', 'session_refresh_tokens'));
  afterAll(() => t.close());

  async function openSession(hash = 'h0') {
    const { row: user } = await users.findOrCreateByEmail(
      t.db,
      'me@example.com',
    );
    return repo.create(t.db, {
      userId: user.id,
      signInMethod: 'email',
      refreshTokenHash: hash,
      ttlDays: 60,
    });
  }

  /** Rotates the session's current token to each hash in turn. */
  async function rotateTo(sessionId: string, ...hashes: string[]) {
    for (const hash of hashes) {
      const { rows } = await t.pool.query<{ refresh_token_hash: string }>(
        'SELECT refresh_token_hash FROM sessions WHERE id = $1',
        [sessionId],
      );
      await t.db.transaction(async (tx) => {
        const locked = await repo.lockByTokenHash(
          tx,
          rows[0]!.refresh_token_hash,
        );
        await repo.rotate(tx, locked!, hash, 60);
      });
    }
  }

  it('opens a session that expires after the given number of days', async () => {
    const { row: user } = await users.findOrCreateByEmail(
      t.db,
      'a@example.com',
    );

    const session = await repo.create(t.db, {
      userId: user.id,
      signInMethod: 'email',
      refreshTokenHash: 'hash',
      ttlDays: 60,
    });

    const days =
      (session.expiresAt.getTime() - session.createdAt.getTime()) / 86_400_000;
    expect(days).toBe(60);
    expect(session).toMatchObject({ userId: user.id, signInMethod: 'email' });
  });

  it('goes with its user when the account is deleted', async () => {
    const { row: user } = await users.findOrCreateByEmail(
      t.db,
      'b@example.com',
    );
    await repo.create(t.db, {
      userId: user.id,
      signInMethod: 'email',
      refreshTokenHash: 'hash',
      ttlDays: 60,
    });

    await t.pool.query('DELETE FROM users');

    const { rows } = await t.pool.query('SELECT 1 FROM sessions');
    expect(rows).toHaveLength(0);
  });

  describe('lockByTokenHash', () => {
    it('finds a session by its current token and by a retired one', async () => {
      const session = await openSession();
      await rotateTo(session.id, 'h1');

      for (const hash of ['h0', 'h1']) {
        const found = await t.db.transaction((tx) =>
          repo.lockByTokenHash(tx, hash),
        );
        expect(found).toMatchObject({
          id: session.id,
          refreshTokenHash: 'h1',
          expired: false,
        });
      }
      await expect(
        t.db.transaction((tx) => repo.lockByTokenHash(tx, 'nope')),
      ).resolves.toBeNull();
    });

    it('reports an expired session as expired', async () => {
      await openSession();
      await t.pool.query(
        "UPDATE sessions SET expires_at = now() - interval '1 second'",
      );

      const found = await t.db.transaction((tx) =>
        repo.lockByTokenHash(tx, 'h0'),
      );
      expect(found?.expired).toBe(true);
    });
  });

  describe('rotate', () => {
    it('replaces the token, retires the old one and slides the expiry', async () => {
      const session = await openSession();
      await t.pool.query(
        "UPDATE sessions SET expires_at = now() + interval '1 day'",
      );

      const rotated = await t.db.transaction(async (tx) => {
        const locked = await repo.lockByTokenHash(tx, 'h0');
        return repo.rotate(tx, locked!, 'h1', 60);
      });

      expect(rotated.refreshTokenHash).toBe('h1');
      const daysLeft = (rotated.expiresAt.getTime() - Date.now()) / 86_400_000;
      expect(daysLeft).toBeGreaterThan(59.9);
      const { rows } = await t.pool.query<{ token_hash: string }>(
        'SELECT token_hash FROM session_refresh_tokens WHERE session_id = $1',
        [session.id],
      );
      expect(rows).toEqual([{ token_hash: 'h0' }]);
    });

    it('lets two refreshes of one token run one after the other', async () => {
      const session = await openSession();

      // Both lock by `h0`. The second waits for the first to commit, then
      // must see the rotated row — current token `h1`, `h0` retired — rather
      // than the one it looked up.
      const results = await Promise.all(
        ['a', 'b'].map((suffix) =>
          t.db.transaction(async (tx) => {
            const locked = await repo.lockByTokenHash(tx, 'h0');
            if (locked === null) throw new Error('not found');
            const wasCurrent = locked.refreshTokenHash === 'h0';
            const retired = wasCurrent
              ? null
              : await repo.findRetiredToken(tx, session.id, 'h0', 30);
            await repo.rotate(tx, locked, `h-${suffix}`, 60);
            return { wasCurrent, retired };
          }),
        ),
      );

      expect(results.filter((r) => r.wasCurrent)).toHaveLength(1);
      expect(results.find((r) => !r.wasCurrent)?.retired).toEqual({
        inGrace: true,
      });
      const { rows } = await t.pool.query(
        'SELECT 1 FROM session_refresh_tokens WHERE session_id = $1',
        [session.id],
      );
      expect(rows).toHaveLength(2);
    });
  });

  describe('findRetiredToken', () => {
    it('gives the last retired token grace, and older ones none', async () => {
      const session = await openSession();
      await rotateTo(session.id, 'h1', 'h2');

      const check = (hash: string) =>
        t.db.transaction((tx) =>
          repo.findRetiredToken(tx, session.id, hash, 30),
        );

      await expect(check('h1')).resolves.toEqual({ inGrace: true });
      await expect(check('h0')).resolves.toEqual({ inGrace: false });
      await expect(check('h2')).resolves.toBeNull();
    });

    it('gives no grace once the window has passed', async () => {
      const session = await openSession();
      await rotateTo(session.id, 'h1');
      await t.pool.query(
        "UPDATE session_refresh_tokens SET retired_at = retired_at - interval '31 seconds'",
      );

      await expect(
        t.db.transaction((tx) =>
          repo.findRetiredToken(tx, session.id, 'h0', 30),
        ),
      ).resolves.toEqual({ inGrace: false });
    });
  });

  describe('deleting', () => {
    it('takes the retired tokens with the session', async () => {
      const session = await openSession();
      await rotateTo(session.id, 'h1');

      await repo.deleteById(t.db, session.id);

      const { rows } = await t.pool.query(
        'SELECT 1 FROM session_refresh_tokens',
      );
      expect(rows).toHaveLength(0);
    });

    it('signs out only by the current token', async () => {
      const session = await openSession();
      await rotateTo(session.id, 'h1');

      await repo.deleteByTokenHash(t.db, 'h0');
      let { rows } = await t.pool.query('SELECT 1 FROM sessions');
      expect(rows).toHaveLength(1);

      await repo.deleteByTokenHash(t.db, 'h1');
      ({ rows } = await t.pool.query('SELECT 1 FROM sessions'));
      expect(rows).toHaveLength(0);
    });
  });
});
