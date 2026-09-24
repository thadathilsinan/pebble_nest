import { eq } from 'drizzle-orm';
import { BlocksRepository } from '../blocks/blocks.repository';
import { taskLedgerEntries } from '../core/database/schema';
import { openTestDatabase, type TestDatabase } from '../core/database/testing';
import { UsersRepository } from '../users/users.repository';
import { TasksRepository, type NewTask } from './tasks.repository';

describe('TasksRepository (integration)', () => {
  let t: TestDatabase;
  const repo = new TasksRepository();
  const users = new UsersRepository();
  const blocks = new BlocksRepository();

  beforeAll(async () => {
    t = await openTestDatabase();
  });
  beforeEach(() => t.truncate('users', 'block_series', 'tasks'));
  afterAll(() => t.close());

  async function newUser(email = 'me@example.com'): Promise<string> {
    return (await users.findOrCreateByEmail(t.db, email)).row.id;
  }

  function task(userId: string, extra: Partial<NewTask> = {}) {
    return {
      userId,
      blockSeriesId: null,
      date: '2026-09-24',
      title: 'Write the report',
      notes: '',
      reminderDate: null,
      reminderMin: null,
      carryCount: 0,
      ...extra,
    } satisfies NewTask;
  }

  function ledgerOf(taskId: string) {
    return t.db
      .select()
      .from(taskLedgerEntries)
      .where(eq(taskLedgerEntries.taskId, taskId))
      .orderBy(taskLedgerEntries.day);
  }

  it('creates an open task at version 0', async () => {
    const userId = await newUser();

    const { row, created } = await repo.create(t.db, task(userId));

    expect(created).toBe(true);
    expect(row).toMatchObject({
      userId,
      title: 'Write the report',
      done: false,
      doneAt: null,
      missed: false,
      version: 0,
    });
  });

  it('returns the original task for a repeated key', async () => {
    const userId = await newUser();
    const key = '0192a000-0000-7000-8000-000000000001';

    const first = await repo.create(
      t.db,
      task(userId, { idempotencyKey: key }),
    );
    const again = await repo.create(
      t.db,
      task(userId, { idempotencyKey: key, title: 'Something else' }),
    );

    expect(again.created).toBe(false);
    expect(again.row).toEqual(first.row);
  });

  it('creates exactly one task when two retries race', async () => {
    const userId = await newUser();
    const key = '0192a000-0000-7000-8000-000000000002';

    const results = await Promise.all([
      t.db.transaction((tx) =>
        repo.create(tx, task(userId, { idempotencyKey: key })),
      ),
      t.db.transaction((tx) =>
        repo.create(tx, task(userId, { idempotencyKey: key })),
      ),
    ]);

    expect(results.map((r) => r.created).sort()).toEqual([false, true]);
    expect(results[0].row.id).toBe(results[1].row.id);
  });

  it('records one incomplete entry per day, both ends included', async () => {
    const userId = await newUser();
    const { row } = await repo.create(t.db, task(userId));

    await repo.recordIncomplete(t.db, row, '2026-09-21', '2026-09-23');

    expect(
      (await ledgerOf(row.id)).map(({ day, outcome, title }) => ({
        day,
        outcome,
        title,
      })),
    ).toEqual([
      { day: '2026-09-21', outcome: 'incomplete', title: 'Write the report' },
      { day: '2026-09-22', outcome: 'incomplete', title: 'Write the report' },
      { day: '2026-09-23', outcome: 'incomplete', title: 'Write the report' },
    ]);
  });

  it('records a range longer than one statement has parameters for', async () => {
    const userId = await newUser();
    const { row } = await repo.create(t.db, task(userId));

    await repo.recordIncomplete(t.db, row, '1900-01-01', '2026-09-23');

    expect(await ledgerOf(row.id)).toHaveLength(46_287);
  });

  it('leaves a day that already recorded the task as it was', async () => {
    const userId = await newUser();
    const { row } = await repo.create(
      t.db,
      task(userId, { date: '2026-09-22' }),
    );
    await repo.recordCompleted(t.db, row);
    await repo.recordIncomplete(t.db, row, '2026-09-21', '2026-09-21');

    await repo.recordIncomplete(t.db, row, '2026-09-21', '2026-09-23');

    expect(
      (await ledgerOf(row.id)).map(({ day, outcome }) => ({ day, outcome })),
    ).toEqual([
      { day: '2026-09-21', outcome: 'incomplete' },
      { day: '2026-09-22', outcome: 'completed' },
      { day: '2026-09-23', outcome: 'incomplete' },
    ]);
  });

  it('keeps the ledger when the task is deleted', async () => {
    const userId = await newUser();
    const { row } = await repo.create(t.db, task(userId));
    await repo.recordIncomplete(t.db, row, '2026-09-23', '2026-09-23');

    await t.pool.query('DELETE FROM tasks WHERE id = $1', [row.id]);

    const { rows } = await t.pool.query<{ task_id: string | null }>(
      'SELECT task_id FROM task_ledger_entries WHERE user_id = $1',
      [userId],
    );
    expect(rows).toEqual([{ task_id: null }]);
  });

  it('finds only the user’s own task', async () => {
    const me = await newUser();
    const other = await newUser('other@example.com');
    const { row } = await repo.create(t.db, task(me));

    const mine = await t.db.transaction((tx) =>
      repo.findForUpdate(tx, me, row.id),
    );
    const theirs = await t.db.transaction((tx) =>
      repo.findForUpdate(tx, other, row.id),
    );

    expect(mine).toEqual(row);
    expect(theirs).toBeNull();
  });

  it('marks a task done and open again, bumping the version each time', async () => {
    const userId = await newUser();
    const { row } = await repo.create(t.db, task(userId));

    const done = await repo.setDone(t.db, row.id, true);
    const open = await repo.setDone(t.db, row.id, false);

    expect(done).toMatchObject({ done: true, version: 1 });
    expect(done.doneAt).toBeInstanceOf(Date);
    expect(open).toMatchObject({
      done: false,
      doneAt: null,
      version: 2,
      date: row.date,
    });
  });

  it('carries a reopened task to a general list in the same write', async () => {
    const userId = await newUser();
    const { row: series } = await blocks.create(t.db, {
      userId,
      name: 'Deep work',
      anchorDate: '2026-09-21',
      startMin: 540,
      endMin: 600,
      recurrenceKind: 'none',
      weekdays: [],
      monthDays: [],
      until: null,
      alert: false,
    });
    const { row } = await repo.create(
      t.db,
      task(userId, {
        date: '2026-09-21',
        blockSeriesId: series.id,
        carryCount: 2,
      }),
    );
    await repo.setDone(t.db, row.id, true);

    const carried = await repo.setDone(t.db, row.id, false, {
      date: '2026-09-24',
      days: 3,
    });

    expect(carried).toMatchObject({
      date: '2026-09-24',
      blockSeriesId: null,
      carryCount: 5,
      version: 2,
    });
  });

  it('records a completed day, replacing what the day held', async () => {
    const userId = await newUser();
    const { row } = await repo.create(t.db, task(userId));
    await repo.recordIncomplete(t.db, row, row.date, row.date);

    await repo.recordCompleted(t.db, row);

    expect(
      (await ledgerOf(row.id)).map(({ day, outcome }) => ({ day, outcome })),
    ).toEqual([{ day: row.date, outcome: 'completed' }]);
  });

  it('edits a task, bumping the version once', async () => {
    const userId = await newUser();
    const { row } = await repo.create(t.db, task(userId));

    const edited = await repo.update(t.db, row.id, {
      title: 'Send the report',
      reminderDate: '2026-09-25',
      reminderMin: 540,
    });

    expect(edited).toMatchObject({
      title: 'Send the report',
      notes: '',
      reminderDate: '2026-09-25',
      reminderMin: 540,
      version: 1,
    });
  });

  it('renames every day the task recorded, and only that task’s', async () => {
    const userId = await newUser();
    const { row } = await repo.create(t.db, task(userId));
    const { row: other } = await repo.create(t.db, task(userId));
    await repo.recordIncomplete(t.db, row, '2026-09-22', '2026-09-23');
    await repo.recordCompleted(t.db, row);
    await repo.recordCompleted(t.db, other);

    await repo.renameLedger(t.db, row.id, 'Send the report');

    expect((await ledgerOf(row.id)).map((e) => e.title)).toEqual([
      'Send the report',
      'Send the report',
      'Send the report',
    ]);
    expect((await ledgerOf(other.id)).map((e) => e.title)).toEqual([
      'Write the report',
    ]);
  });

  it('clears one day of a task’s record', async () => {
    const userId = await newUser();
    const { row } = await repo.create(t.db, task(userId));
    await repo.recordIncomplete(t.db, row, '2026-09-22', '2026-09-24');

    await repo.clearDay(t.db, row.id, '2026-09-24');

    expect((await ledgerOf(row.id)).map((e) => e.day)).toEqual([
      '2026-09-22',
      '2026-09-23',
    ]);
  });

  it('moves a task, adding carries and bumping the version once', async () => {
    const userId = await newUser();
    const { row: series } = await blocks.create(t.db, {
      userId,
      name: 'Deep work',
      anchorDate: '2026-09-25',
      startMin: 540,
      endMin: 600,
      recurrenceKind: 'none',
      weekdays: [],
      monthDays: [],
      until: null,
      alert: false,
    });
    const { row } = await repo.create(t.db, task(userId, { carryCount: 1 }));

    const inBlock = await repo.move(t.db, row.id, {
      date: '2026-09-25',
      blockSeriesId: series.id,
      carryDays: 0,
    });
    const carried = await repo.move(t.db, row.id, {
      date: '2026-09-24',
      blockSeriesId: null,
      carryDays: 2,
    });

    expect(inBlock).toMatchObject({
      date: '2026-09-25',
      blockSeriesId: series.id,
      carryCount: 1,
      version: 1,
    });
    expect(carried).toMatchObject({
      date: '2026-09-24',
      blockSeriesId: null,
      carryCount: 3,
      version: 2,
    });
  });

  it('reads the open tasks of one occurrence, and only those', async () => {
    const userId = await newUser();
    const other = await newUser('other@example.com');
    const { row: series } = await blocks.create(t.db, {
      userId,
      name: 'Deep work',
      anchorDate: '2026-09-24',
      startMin: 540,
      endMin: 600,
      recurrenceKind: 'daily',
      weekdays: [],
      monthDays: [],
      until: null,
      alert: false,
    });
    const inBlock = { blockSeriesId: series.id };
    await repo.create(t.db, task(userId, { ...inBlock, title: 'Open' }));
    const { row: done } = await repo.create(
      t.db,
      task(userId, { ...inBlock, title: 'Done' }),
    );
    await repo.setDone(t.db, done.id, true);
    await repo.create(
      t.db,
      task(userId, { ...inBlock, title: 'Next day', date: '2026-09-25' }),
    );
    await repo.create(t.db, task(userId, { title: 'General' }));
    // Not a real placement, but the filter on the owner must hold anyway.
    await repo.create(t.db, task(other, { ...inBlock, title: 'Not mine' }));

    const rows = await t.db.transaction((tx) =>
      repo.findOpenInOccurrenceForUpdate(tx, userId, series.id, '2026-09-24'),
    );

    expect(rows.map((r) => r.title)).toEqual(['Open']);
  });

  it('deletes only the user’s own task', async () => {
    const me = await newUser();
    const other = await newUser('other@example.com');
    const { row } = await repo.create(t.db, task(me));

    expect(await repo.delete(t.db, other, row.id)).toBe(false);
    expect(await repo.delete(t.db, me, row.id)).toBe(true);
    expect(await repo.delete(t.db, me, row.id)).toBe(false);
  });

  it('reads only the user’s tasks in the range', async () => {
    const me = await newUser();
    const other = await newUser('other@example.com');
    await repo.create(t.db, task(me, { date: '2026-09-23', title: 'Before' }));
    await repo.create(t.db, task(me, { date: '2026-09-24', title: 'From' }));
    await repo.create(t.db, task(me, { date: '2026-09-25', title: 'To' }));
    await repo.create(t.db, task(me, { date: '2026-09-26', title: 'After' }));
    await repo.create(t.db, task(other, { date: '2026-09-24' }));

    const rows = await repo.findBetween(t.db, me, '2026-09-24', '2026-09-25');

    expect(rows.map((r) => r.task.title).sort()).toEqual(['From', 'To']);
  });

  describe('the review’s reads', () => {
    async function withLedger(
      userId: string,
      extra: Partial<NewTask>,
      outcomes: [day: string, outcome: 'completed' | 'incomplete' | 'missed'][],
    ) {
      const { row } = await repo.create(t.db, task(userId, extra));
      if (outcomes.length > 0) {
        await t.db.insert(taskLedgerEntries).values(
          outcomes.map(([day, outcome]) => ({
            userId,
            taskId: row.id,
            day,
            outcome,
            title: row.title,
          })),
        );
      }
      return row;
    }

    it('counts the ledger in the range by outcome, missed as incomplete', async () => {
      const me = await newUser();
      const other = await newUser('other@example.com');
      await withLedger(me, { title: 'A' }, [
        ['2026-09-20', 'incomplete'],
        ['2026-09-21', 'incomplete'],
        ['2026-09-22', 'completed'],
      ]);
      await withLedger(me, { title: 'B' }, [
        ['2026-09-21', 'missed'],
        ['2026-09-23', 'completed'],
      ]);
      await withLedger(other, { title: 'C' }, [['2026-09-21', 'completed']]);

      expect(
        await repo.countLedgerBetween(t.db, me, '2026-09-21', '2026-09-22'),
      ).toEqual({ completed: 1, incomplete: 2 });
      expect(
        await repo.countLedgerBetween(t.db, me, '2026-10-01', '2026-10-31'),
      ).toEqual({ completed: 0, incomplete: 0 });
    });

    it('keeps a deleted task’s days in the count', async () => {
      const me = await newUser();
      const row = await withLedger(me, {}, [['2026-09-21', 'incomplete']]);
      await repo.delete(t.db, me, row.id);

      expect(
        await repo.countLedgerBetween(t.db, me, '2026-09-21', '2026-09-21'),
      ).toEqual({ completed: 0, incomplete: 1 });
    });

    it('finds the most carried tasks active in the period, top first', async () => {
      const me = await newUser();
      const other = await newUser('other@example.com');
      // Carried through the period and on out of it.
      await withLedger(
        me,
        { title: 'Left', date: '2026-10-05', carryCount: 9 },
        [['2026-09-22', 'incomplete']],
      );
      // Sits in the period now.
      await withLedger(
        me,
        { title: 'Here', date: '2026-09-22', carryCount: 3 },
        [],
      );
      // Carried, but only before the period.
      await withLedger(
        me,
        { title: 'Before', date: '2026-10-05', carryCount: 7 },
        [['2026-09-10', 'incomplete']],
      );
      // Only completed in the period.
      await withLedger(
        me,
        { title: 'Done', date: '2026-10-05', carryCount: 5 },
        [['2026-09-22', 'completed']],
      );
      // In the period, never carried.
      await withLedger(me, { title: 'Fresh', date: '2026-09-22' }, []);
      await withLedger(
        other,
        { title: 'Theirs', date: '2026-09-22', carryCount: 8 },
        [],
      );

      const rows = await repo.findMostCarried(
        t.db,
        me,
        '2026-09-21',
        '2026-09-27',
        5,
      );

      expect(rows.map((r) => r.task.title)).toEqual(['Left', 'Here']);
    });

    it('ranks ties by title, ignoring capitals, and keeps to the limit', async () => {
      const me = await newUser();
      for (const title of ['delta', 'Charlie', 'bravo', 'Alpha']) {
        await withLedger(me, { title, carryCount: 2 }, []);
      }
      await withLedger(me, { title: 'Zulu', carryCount: 4 }, []);

      const rows = await repo.findMostCarried(
        t.db,
        me,
        '2026-09-24',
        '2026-09-24',
        3,
      );

      expect(rows.map((r) => r.task.title)).toEqual(['Zulu', 'Alpha', 'bravo']);
    });
  });
});
