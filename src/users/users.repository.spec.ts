import { openTestDatabase, type TestDatabase } from '../database/testing';
import { UsersRepository } from './users.repository';

describe('UsersRepository (integration)', () => {
  let t: TestDatabase;
  const repo = new UsersRepository();

  beforeAll(async () => {
    t = await openTestDatabase();
  });
  beforeEach(() => t.truncate('users'));
  afterAll(() => t.close());

  it('opens an account with the profile defaults', async () => {
    const { row, created } = await repo.findOrCreateByEmail(
      t.db,
      'new@example.com',
    );

    expect(created).toBe(true);
    expect(row).toMatchObject({
      email: 'new@example.com',
      name: null,
      weekStart: 'monday',
      timeFormat: 'system',
      timeZone: null,
      version: 0,
    });
  });

  it('returns the existing account for a known email', async () => {
    const first = await repo.findOrCreateByEmail(t.db, 'me@example.com');
    const second = await repo.findOrCreateByEmail(t.db, 'me@example.com');

    expect(second.created).toBe(false);
    expect(second.row.id).toBe(first.row.id);
  });

  it('opens exactly one account when two sign-ins race', async () => {
    const results = await Promise.all([
      t.db.transaction((tx) =>
        repo.findOrCreateByEmail(tx, 'race@example.com'),
      ),
      t.db.transaction((tx) =>
        repo.findOrCreateByEmail(tx, 'race@example.com'),
      ),
    ]);

    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(results[0].row.id).toBe(results[1].row.id);
  });

  it('refuses a mixed-case email rather than opening a second account', async () => {
    await expect(
      repo.findOrCreateByEmail(t.db, 'Me@Example.com'),
    ).rejects.toMatchObject({
      cause: { constraint: 'ck_users_email_lowercase' },
    });
  });
});
