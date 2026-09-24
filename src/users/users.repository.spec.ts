import { openTestDatabase, type TestDatabase } from '../core/database/testing';
import { SessionsRepository } from '../auth/sessions.repository';
import { BlocksRepository } from '../blocks/blocks.repository';
import { taskLedgerEntries } from '../core/database/schema';
import { TasksRepository } from '../tasks/tasks.repository';
import { UsersRepository } from './users.repository';

describe('UsersRepository (integration)', () => {
  let t: TestDatabase;
  const repo = new UsersRepository();
  const sessions = new SessionsRepository();

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

  describe('deleteById', () => {
    it('deletes the account with its sessions and retired tokens', async () => {
      const { row } = await repo.findOrCreateByEmail(t.db, 'me@example.com');
      const other = await repo.findOrCreateByEmail(t.db, 'other@example.com');
      const session = await sessions.create(t.db, {
        userId: row.id,
        signInMethod: 'email',
        refreshTokenHash: 'h1',
        ttlDays: 60,
      });
      await t.db.transaction(async (tx) => {
        const locked = await sessions.lockByTokenHash(tx, 'h1');
        await sessions.rotate(tx, locked!, 'h2', 60);
      });
      await sessions.create(t.db, {
        userId: other.row.id,
        signInMethod: 'email',
        refreshTokenHash: 'other',
        ttlDays: 60,
      });

      await expect(repo.deleteById(t.db, row.id)).resolves.toMatchObject({
        id: row.id,
        email: 'me@example.com',
      });

      await expect(repo.findById(t.db, row.id)).resolves.toBeNull();
      await expect(sessions.findLiveById(t.db, session.id)).resolves.toBeNull();
      const { rows } = await t.pool.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM session_refresh_tokens',
      );
      expect(rows).toEqual([{ n: 0 }]);
      await expect(repo.findById(t.db, other.row.id)).resolves.not.toBeNull();
    });

    it('returns null for an unknown id', async () => {
      await expect(
        repo.deleteById(t.db, '01900000-0000-7000-8000-000000000000'),
      ).resolves.toBeNull();
    });
  });

  describe('findRecordStart', () => {
    const blocks = new BlocksRepository();
    const tasks = new TasksRepository();

    function newBlock(userId: string, anchorDate: string) {
      return blocks.create(t.db, {
        userId,
        name: 'Deep work',
        anchorDate,
        startMin: 540,
        endMin: 600,
        recurrenceKind: 'none',
        weekdays: [],
        monthDays: [],
        until: null,
        alert: false,
      });
    }

    function newTask(userId: string, date: string) {
      return tasks.create(t.db, {
        userId,
        blockSeriesId: null,
        date,
        title: 'Write the report',
        notes: '',
        reminderDate: null,
        reminderMin: null,
        carryCount: 0,
      });
    }

    it('finds no record for a new account', async () => {
      const { row } = await repo.findOrCreateByEmail(t.db, 'me@example.com');

      expect(await repo.findRecordStart(t.db, row.id)).toEqual({
        firstRecordedDay: null,
        hasAnyRecord: false,
      });
    });

    it('takes the earliest of block anchors, task dates and ledger days, and only the user’s own', async () => {
      const { row: me } = await repo.findOrCreateByEmail(
        t.db,
        'me@example.com',
      );
      const { row: other } = await repo.findOrCreateByEmail(
        t.db,
        'other@example.com',
      );
      await newBlock(me.id, '2026-09-20');
      const { row: task } = await newTask(me.id, '2026-09-24');
      await t.db.insert(taskLedgerEntries).values({
        userId: me.id,
        taskId: task.id,
        day: '2026-09-18',
        outcome: 'incomplete',
        title: task.title,
      });
      await newBlock(other.id, '2026-01-01');

      expect(await repo.findRecordStart(t.db, me.id)).toEqual({
        firstRecordedDay: '2026-09-18',
        hasAnyRecord: true,
      });
    });

    it('counts a task alone as a record', async () => {
      const { row } = await repo.findOrCreateByEmail(t.db, 'me@example.com');
      await newTask(row.id, '2026-09-24');

      expect(await repo.findRecordStart(t.db, row.id)).toEqual({
        firstRecordedDay: '2026-09-24',
        hasAnyRecord: true,
      });
    });

    it('keeps a deleted task’s ledger days as the start, but not as a record', async () => {
      const { row } = await repo.findOrCreateByEmail(t.db, 'me@example.com');
      const { row: task } = await newTask(row.id, '2026-09-24');
      await t.db.insert(taskLedgerEntries).values({
        userId: row.id,
        taskId: task.id,
        day: '2026-09-22',
        outcome: 'incomplete',
        title: task.title,
      });
      await tasks.delete(t.db, row.id, task.id);

      // As in the app: the Now screen's "anything yet?" counts blocks and
      // tasks, while the review can still reach back to the recorded day.
      expect(await repo.findRecordStart(t.db, row.id)).toEqual({
        firstRecordedDay: '2026-09-22',
        hasAnyRecord: false,
      });
    });
  });
});
