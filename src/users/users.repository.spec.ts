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

  describe('updateVersioned', () => {
    it('applies the patch and bumps the version', async () => {
      const { row } = await repo.findOrCreateByEmail(t.db, 'me@example.com');

      const result = await repo.updateVersioned(t.db, row.id, 0, {
        name: 'Sinan',
        weekStart: 'sunday',
      });

      expect(result).toMatchObject({
        outcome: 'updated',
        row: { name: 'Sinan', weekStart: 'sunday', version: 1 },
      });
    });

    it('reports stale with the current row when the version has moved on', async () => {
      const { row } = await repo.findOrCreateByEmail(t.db, 'me@example.com');
      await repo.updateVersioned(t.db, row.id, 0, { name: 'First' });

      const result = await repo.updateVersioned(t.db, row.id, 0, {
        name: 'Second',
      });

      expect(result).toMatchObject({
        outcome: 'stale',
        row: { name: 'First', version: 1 },
      });
    });

    it('reports missing for an unknown id', async () => {
      const result = await repo.updateVersioned(
        t.db,
        '01900000-0000-7000-8000-000000000000',
        0,
        { name: 'Nobody' },
      );

      expect(result).toEqual({ outcome: 'missing' });
    });

    it('writes nothing for a patch that changes nothing', async () => {
      const { row } = await repo.findOrCreateByEmail(t.db, 'me@example.com');

      const result = await repo.updateVersioned(t.db, row.id, 0, {
        weekStart: 'monday',
        name: null,
      });

      expect(result).toMatchObject({
        outcome: 'updated',
        row: { version: 0, updatedAt: row.updatedAt },
      });
    });

    it('still reports stale for a no-op patch on an old version', async () => {
      const { row } = await repo.findOrCreateByEmail(t.db, 'me@example.com');
      await repo.updateVersioned(t.db, row.id, 0, { name: 'First' });

      const result = await repo.updateVersioned(t.db, row.id, 0, {
        name: 'First',
      });

      expect(result).toMatchObject({ outcome: 'stale', row: { version: 1 } });
    });

    it('treats an empty patch as a version check', async () => {
      const { row } = await repo.findOrCreateByEmail(t.db, 'me@example.com');

      await expect(
        repo.updateVersioned(t.db, row.id, 0, {}),
      ).resolves.toMatchObject({ outcome: 'updated', row: { version: 0 } });
      await expect(
        repo.updateVersioned(t.db, row.id, 5, {}),
      ).resolves.toMatchObject({ outcome: 'stale', row: { version: 0 } });
    });
  });

  describe('setTimeZone', () => {
    it('records a new zone and bumps the version', async () => {
      const { row } = await repo.findOrCreateByEmail(t.db, 'me@example.com');

      await expect(
        repo.setTimeZone(t.db, row.id, 'Asia/Kolkata'),
      ).resolves.toMatchObject({ timeZone: 'Asia/Kolkata', version: 1 });
    });

    it('writes nothing when the zone is already stored', async () => {
      const { row } = await repo.findOrCreateByEmail(t.db, 'me@example.com');
      await repo.setTimeZone(t.db, row.id, 'Asia/Kolkata');

      await expect(
        repo.setTimeZone(t.db, row.id, 'Asia/Kolkata'),
      ).resolves.toMatchObject({ timeZone: 'Asia/Kolkata', version: 1 });
    });

    it('returns null for an unknown id', async () => {
      await expect(
        repo.setTimeZone(
          t.db,
          '01900000-0000-7000-8000-000000000000',
          'Asia/Kolkata',
        ),
      ).resolves.toBeNull();
    });
  });
});
