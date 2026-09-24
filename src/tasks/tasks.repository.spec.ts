import { eq } from 'drizzle-orm';
import { taskLedgerEntries } from '../core/database/schema';
import { openTestDatabase, type TestDatabase } from '../core/database/testing';
import { UsersRepository } from '../users/users.repository';
import { TasksRepository, type NewTask } from './tasks.repository';

describe('TasksRepository (integration)', () => {
  let t: TestDatabase;
  const repo = new TasksRepository();
  const users = new UsersRepository();

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

  it('reads only the user’s tasks in the range', async () => {
    const me = await newUser();
    const other = await newUser('other@example.com');
    await repo.create(t.db, task(me, { date: '2026-09-23', title: 'Before' }));
    await repo.create(t.db, task(me, { date: '2026-09-24', title: 'From' }));
    await repo.create(t.db, task(me, { date: '2026-09-25', title: 'To' }));
    await repo.create(t.db, task(me, { date: '2026-09-26', title: 'After' }));
    await repo.create(t.db, task(other, { date: '2026-09-24' }));

    const rows = await repo.findBetween(t.db, me, '2026-09-24', '2026-09-25');

    expect(rows.map((r) => r.title).sort()).toEqual(['From', 'To']);
  });
});
