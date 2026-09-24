import { openTestDatabase, type TestDatabase } from '../core/database/testing';
import {
  SignInCodesRepository,
  type SendLimits,
} from './sign-in-codes.repository';

const LIMITS: SendLimits = {
  ttlSeconds: 600,
  cooldownSeconds: 30,
  windowSeconds: 3600,
  maxSendsPerWindow: 5,
};
const EMAIL = 'someone@example.com';

describe('SignInCodesRepository (integration)', () => {
  let t: TestDatabase;
  const repo = new SignInCodesRepository();

  beforeAll(async () => {
    t = await openTestDatabase();
  });
  beforeEach(() => t.truncate('email_sign_in_codes'));
  afterAll(() => t.close());

  /** Moves the row's clocks into the past, as if `seconds` had gone by. */
  async function age(seconds: number): Promise<void> {
    await t.pool.query(
      `UPDATE email_sign_in_codes
         SET last_sent_at = last_sent_at - make_interval(secs => $1),
             window_started_at = window_started_at - make_interval(secs => $1),
             expires_at = expires_at - make_interval(secs => $1)`,
      [seconds],
    );
  }

  async function row() {
    const { rows } = await t.pool.query<{
      code_hash: string;
      attempts: number;
      sends_in_window: number;
    }>('SELECT code_hash, attempts, sends_in_window FROM email_sign_in_codes');
    return rows;
  }

  it('stores the first code for an address', async () => {
    await expect(repo.issue(t.db, EMAIL, 'h1', LIMITS)).resolves.toEqual({
      outcome: 'issued',
    });
    expect(await row()).toEqual([
      { code_hash: 'h1', attempts: 0, sends_in_window: 1 },
    ]);
  });

  it('refuses a second send inside the cooldown and changes nothing', async () => {
    await repo.issue(t.db, EMAIL, 'h1', LIMITS);

    const result = await repo.issue(t.db, EMAIL, 'h2', LIMITS);

    expect(result.outcome).toBe('limited');
    if (result.outcome === 'limited') {
      expect(result.retryAfterSeconds).toBeGreaterThanOrEqual(29);
      expect(result.retryAfterSeconds).toBeLessThanOrEqual(30);
    }
    expect(await row()).toEqual([
      { code_hash: 'h1', attempts: 0, sends_in_window: 1 },
    ]);
  });

  it('replaces the code and resets attempts once the cooldown has passed', async () => {
    await repo.issue(t.db, EMAIL, 'h1', LIMITS);
    await t.pool.query('UPDATE email_sign_in_codes SET attempts = 3');
    await age(31);

    await expect(repo.issue(t.db, EMAIL, 'h2', LIMITS)).resolves.toEqual({
      outcome: 'issued',
    });
    expect(await row()).toEqual([
      { code_hash: 'h2', attempts: 0, sends_in_window: 2 },
    ]);
  });

  it('refuses a sixth send in the hour, until the window ends', async () => {
    for (let sent = 0; sent < 5; sent++) {
      await expect(
        repo.issue(t.db, EMAIL, `h${sent}`, LIMITS),
      ).resolves.toEqual({ outcome: 'issued' });
      await age(60);
    }

    // Five sends, 60s apart each: the window opened 300s ago, so it has about
    // 3300s left — far longer than the cooldown, which has already passed.
    const refused = await repo.issue(t.db, EMAIL, 'h5', LIMITS);
    expect(refused.outcome).toBe('limited');
    if (refused.outcome === 'limited') {
      expect(refused.retryAfterSeconds).toBeGreaterThan(3200);
      expect(refused.retryAfterSeconds).toBeLessThanOrEqual(3300);
    }

    await age(3300);
    await expect(repo.issue(t.db, EMAIL, 'h6', LIMITS)).resolves.toEqual({
      outcome: 'issued',
    });
    expect(await row()).toEqual([
      { code_hash: 'h6', attempts: 0, sends_in_window: 1 },
    ]);
  });

  it('judges expiry on the database clock', async () => {
    await repo.issue(t.db, EMAIL, 'h1', LIMITS);

    const fresh = await t.db.transaction((tx) => repo.lockByEmail(tx, EMAIL));
    expect(fresh?.expired).toBe(false);

    await age(601);
    const stale = await t.db.transaction((tx) => repo.lockByEmail(tx, EMAIL));
    expect(stale?.expired).toBe(true);
  });

  it('finds nothing for an address with no code', async () => {
    await expect(
      t.db.transaction((tx) => repo.lockByEmail(tx, 'nobody@example.com')),
    ).resolves.toBeNull();
  });

  it('kills a consumed code without resetting the send counters', async () => {
    await repo.issue(t.db, EMAIL, 'h1', LIMITS);

    await t.db.transaction(async (tx) => {
      const locked = await repo.lockByEmail(tx, EMAIL);
      await repo.consume(tx, locked!.id);
    });

    const after = await t.db.transaction((tx) => repo.lockByEmail(tx, EMAIL));
    expect(after?.expired).toBe(true);
    expect(after?.sendsInWindow).toBe(1);
  });

  // The reason `lockByEmail` takes FOR UPDATE: without the lock both
  // transactions read the same `attempts` and one wrong guess goes uncounted.
  it('serialises concurrent attempts on one code', async () => {
    await repo.issue(t.db, EMAIL, 'h1', LIMITS);

    const seen = await Promise.all(
      [1, 2].map(() =>
        t.db.transaction(async (tx) => {
          const locked = await repo.lockByEmail(tx, EMAIL);
          return {
            before: locked!.attempts,
            after: await repo.recordFailedAttempt(tx, locked!.id),
          };
        }),
      ),
    );

    expect(seen.map((s) => s.before).sort()).toEqual([0, 1]);
    expect(seen.map((s) => s.after).sort()).toEqual([1, 2]);
  });

  it('deletes only the row for the given email', async () => {
    await repo.issue(t.db, EMAIL, 'h1', LIMITS);
    await repo.issue(t.db, 'other@example.com', 'h2', LIMITS);

    await repo.deleteByEmail(t.db, EMAIL);

    expect(await row()).toEqual([
      { code_hash: 'h2', attempts: 0, sends_in_window: 1 },
    ]);
  });
});
