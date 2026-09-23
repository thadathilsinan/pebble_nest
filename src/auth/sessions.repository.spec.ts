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
  beforeEach(() => t.truncate('users', 'sessions'));
  afterAll(() => t.close());

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
});
