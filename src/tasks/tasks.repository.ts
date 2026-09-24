import { Injectable } from '@nestjs/common';
import {
  and,
  desc,
  eq,
  gt,
  gte,
  inArray,
  lte,
  ne,
  not,
  or,
  sql,
} from 'drizzle-orm';
import type { Executor } from '../core/database/database.module';
import {
  taskLedgerEntries,
  taskSeries,
  tasks,
  type TaskRow,
} from '../core/database/schema';
import type { TaskWithSeries } from './tasks.mapper';

/** The columns `POST /tasks` writes. */
export type NewTask = Pick<
  TaskRow,
  | 'userId'
  | 'blockSeriesId'
  | 'date'
  | 'title'
  | 'notes'
  | 'reminderDate'
  | 'reminderMin'
  | 'carryCount'
> & { missed?: boolean; idempotencyKey?: string };

/**
 * Where a reopened task on a closed day is carried in the same write: to
 * `date`, `days` carries further on, and missed there or not.
 */
export interface Carry {
  date: string;
  days: number;
  missed?: boolean;
}

/**
 * The columns `PATCH /tasks/{id}` edits, and the series it links the task
 * to or unlinks it from.
 */
export type TaskChanges = Partial<
  Pick<
    TaskRow,
    'title' | 'notes' | 'reminderDate' | 'reminderMin' | 'taskSeriesId'
  >
>;

@Injectable()
export class TasksRepository {
  /**
   * Inserts a task, or returns the one an earlier request with the same
   * idempotency key created (schema-conventions §9). `created` is false for
   * that replay. Insert-first, for the reasons `BlocksRepository.create`
   * gives: when this runs inside a transaction, a racing retry's
   * `ON CONFLICT DO NOTHING` waits for that whole transaction to commit.
   */
  async create(
    ex: Executor,
    values: NewTask,
  ): Promise<{ row: TaskRow; created: boolean }> {
    const [created] = await ex
      .insert(tasks)
      .values(values)
      .onConflictDoNothing({ target: [tasks.userId, tasks.idempotencyKey] })
      .returning();

    if (created !== undefined) return { row: created, created: true };

    // Only a repeated key conflicts: a null key never does.
    const key = values.idempotencyKey;
    if (key === undefined) throw new Error('insert without a key conflicted');

    const [existing] = await ex
      .select()
      .from(tasks)
      .where(
        and(eq(tasks.userId, values.userId), eq(tasks.idempotencyKey, key)),
      )
      .limit(1);

    if (existing === undefined) {
      throw new Error('task vanished between insert conflict and select');
    }

    return { row: existing, created: false };
  }

  /**
   * Records `task` incomplete on every day from `from` to `to`, both
   * included: what the day-end job would have written had the task sat open
   * through them (TSK-06/07).
   *
   * One statement over `generate_series` rather than a row per day from here,
   * because a task put years in the past needs thousands of rows, more than
   * one statement's bind parameters allow.
   *
   * A day that already holds an entry for the task keeps it. That happens
   * when a task is moved back onto days it has already carried through, and
   * each day records the task once.
   */
  async recordIncomplete(
    ex: Executor,
    task: TaskRow,
    from: string,
    to: string,
  ): Promise<void> {
    await ex.execute(sql`
      INSERT INTO ${taskLedgerEntries}
        (user_id, task_id, day, outcome, title)
      SELECT ${task.userId}, ${task.id}, day::date, 'incomplete', ${task.title}
      FROM generate_series(${from}::date, ${to}::date, interval '1 day') AS day
      ON CONFLICT (task_id, day) DO NOTHING
    `);
  }

  /**
   * The caller's task, locked until the transaction ends so two devices
   * toggling it at once take turns. `null` when there is no such task or it
   * is someone else's.
   */
  async findForUpdate(
    ex: Executor,
    userId: string,
    id: string,
  ): Promise<TaskRow | null> {
    const [row] = await ex
      .select()
      .from(tasks)
      .where(and(eq(tasks.userId, userId), eq(tasks.id, id)))
      .limit(1)
      .for('update');
    return row ?? null;
  }

  /**
   * The open tasks in the occurrence of `blockSeriesId` that starts on
   * `date`, locked until the transaction ends. A task another transaction
   * moves out first is skipped over once that one commits, since Postgres
   * rechecks the filter on a row it waited for. Uses
   * `idx_tasks_block_series_id`.
   */
  findOpenInOccurrenceForUpdate(
    ex: Executor,
    userId: string,
    blockSeriesId: string,
    date: string,
  ): Promise<TaskRow[]> {
    return ex
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.userId, userId),
          eq(tasks.blockSeriesId, blockSeriesId),
          eq(tasks.date, date),
          eq(tasks.done, false),
        ),
      )
      .orderBy(tasks.id)
      .for('update');
  }

  /**
   * The tasks, open and done, in the occurrence of `blockSeriesId` that
   * starts on `date`, and with `from` in every occurrence starting on or
   * after it too. Locked until the transaction ends, as
   * `findOpenInOccurrenceForUpdate` locks. Uses `idx_tasks_block_series_id`.
   */
  findInSeriesForUpdate(
    ex: Executor,
    userId: string,
    blockSeriesId: string,
    { date, from }: { date: string; from?: string },
  ): Promise<TaskRow[]> {
    return ex
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.userId, userId),
          eq(tasks.blockSeriesId, blockSeriesId),
          from === undefined
            ? eq(tasks.date, date)
            : or(eq(tasks.date, date), gte(tasks.date, from)),
        ),
      )
      .orderBy(tasks.id)
      .for('update');
  }

  /**
   * Every task, open and done, in any occurrence of `blockSeriesId`, locked
   * as `findOpenInOccurrenceForUpdate` locks. Uses
   * `idx_tasks_block_series_id`.
   */
  findAllInSeriesForUpdate(
    ex: Executor,
    userId: string,
    blockSeriesId: string,
  ): Promise<TaskRow[]> {
    return ex
      .select()
      .from(tasks)
      .where(
        and(eq(tasks.userId, userId), eq(tasks.blockSeriesId, blockSeriesId)),
      )
      .orderBy(tasks.id)
      .for('update');
  }

  /**
   * Marks the task done, stamping `doneAt` with the database's clock, or
   * open again. A reopened task on a closed day is `carry`-ed in the same
   * write: to `carry.date`, `carry.days` carries further on, and out of its
   * block if that takes it off its day. Bumps `version` once either way. The
   * caller has checked `done` changes.
   */
  async setDone(
    ex: Executor,
    id: string,
    done: boolean,
    carry?: Carry,
  ): Promise<TaskRow> {
    const [row] = await ex
      .update(tasks)
      .set({
        done,
        doneAt: done ? sql`now()` : null,
        version: sql`${tasks.version} + 1`,
        ...(carry && {
          date: carry.date,
          carryCount: sql`${tasks.carryCount} + ${carry.days}`,
          missed: carry.missed ?? false,
          ...(carry.days > 0 && { blockSeriesId: null }),
        }),
      })
      .where(eq(tasks.id, id))
      .returning();

    if (row === undefined) throw new Error('task vanished while locked');
    return row;
  }

  /**
   * Records `task` completed on the day it sits on (TSK-04), replacing
   * whatever that day held for it.
   */
  async recordCompleted(ex: Executor, task: TaskRow): Promise<void> {
    await ex
      .insert(taskLedgerEntries)
      .values({
        userId: task.userId,
        taskId: task.id,
        day: task.date,
        outcome: 'completed',
        title: task.title,
      })
      .onConflictDoUpdate({
        target: [taskLedgerEntries.taskId, taskLedgerEntries.day],
        set: { outcome: 'completed', title: task.title },
      });
  }

  /**
   * Records `task` missed on the day it sits on (REC-06), replacing whatever
   * that day held for it.
   */
  async recordMissed(ex: Executor, task: TaskRow): Promise<void> {
    await ex
      .insert(taskLedgerEntries)
      .values({
        userId: task.userId,
        taskId: task.id,
        day: task.date,
        outcome: 'missed',
        title: task.title,
      })
      .onConflictDoUpdate({
        target: [taskLedgerEntries.taskId, taskLedgerEntries.day],
        set: { outcome: 'missed', title: task.title },
      });
  }

  /**
   * Makes a task just created the first occurrence of `taskSeriesId`. Not a
   * user's edit, so `version` stays.
   */
  async linkSeries(
    ex: Executor,
    id: string,
    taskSeriesId: string,
  ): Promise<TaskRow> {
    const [row] = await ex
      .update(tasks)
      .set({ taskSeriesId })
      .where(eq(tasks.id, id))
      .returning();

    if (row === undefined) throw new Error('task vanished while linking');
    return row;
  }

  /**
   * Writes `changes` to the task and bumps `version` once. The caller holds
   * the row's lock, has checked the version, and passes only fields that
   * differ.
   */
  async update(
    ex: Executor,
    id: string,
    changes: TaskChanges,
  ): Promise<TaskRow> {
    const [row] = await ex
      .update(tasks)
      .set({ ...changes, version: sql`${tasks.version} + 1` })
      .where(eq(tasks.id, id))
      .returning();

    if (row === undefined) throw new Error('task vanished while locked');
    return row;
  }

  /**
   * Gives every day the task recorded its current title (decision 25), so
   * the history reads as the task is now called.
   */
  async renameLedger(
    ex: Executor,
    taskId: string,
    title: string,
  ): Promise<void> {
    await ex
      .update(taskLedgerEntries)
      .set({ title })
      .where(eq(taskLedgerEntries.taskId, taskId));
  }

  /**
   * Puts the task on `to.date`, in `to.blockSeriesId`'s occurrence or on the
   * general list, and bumps `version` once. `carryDays` adds carries, for a
   * task moved onto a closed day and carried on from there. `splitOff`
   * makes an occurrence of a repeating task a one-off (TSK-03). The caller
   * holds the row's lock and has checked the place changes.
   */
  async move(
    ex: Executor,
    id: string,
    to: {
      date: string;
      blockSeriesId: string | null;
      carryDays: number;
      splitOff?: boolean;
    },
  ): Promise<TaskRow> {
    const [row] = await ex
      .update(tasks)
      .set({
        date: to.date,
        blockSeriesId: to.blockSeriesId,
        carryCount: sql`${tasks.carryCount} + ${to.carryDays}`,
        version: sql`${tasks.version} + 1`,
        ...(to.splitOff && { taskSeriesId: null }),
      })
      .where(eq(tasks.id, id))
      .returning();

    if (row === undefined) throw new Error('task vanished while locked');
    return row;
  }

  /**
   * Deletes the caller's task. `false` when there is no such task or it is
   * someone else's. Its ledger entries stay, keeping their titles.
   */
  async delete(ex: Executor, userId: string, id: string): Promise<boolean> {
    const deleted = await ex
      .delete(tasks)
      .where(and(eq(tasks.userId, userId), eq(tasks.id, id)))
      .returning({ id: tasks.id });
    return deleted.length > 0;
  }

  /**
   * Gives the series' open occurrences dated after `after` the task's new
   * title and reminder, bumping each one's `version` and renaming what its
   * days recorded (decisions 5, 25). A reminder moves with each date:
   * `reminderDayOffset` days after it. Done ones keep what they were done
   * as.
   */
  async applyToLaterOpen(
    ex: Executor,
    taskSeriesId: string,
    after: string,
    changes: {
      title?: string;
      reminder?: { dayOffset: number; min: number } | null;
    },
  ): Promise<void> {
    const reminder = changes.reminder;
    const updated = await ex
      .update(tasks)
      .set({
        ...(changes.title !== undefined && { title: changes.title }),
        ...(reminder !== undefined && {
          reminderDate:
            reminder === null
              ? null
              : sql`${tasks.date} + ${reminder.dayOffset}::int`,
          reminderMin: reminder?.min ?? null,
        }),
        version: sql`${tasks.version} + 1`,
      })
      .where(
        and(
          eq(tasks.taskSeriesId, taskSeriesId),
          gt(tasks.date, after),
          eq(tasks.done, false),
        ),
      )
      .returning({ id: tasks.id });

    if (changes.title !== undefined && updated.length > 0) {
      await ex
        .update(taskLedgerEntries)
        .set({ title: changes.title })
        .where(
          inArray(
            taskLedgerEntries.taskId,
            updated.map((row) => row.id),
          ),
        );
    }
  }

  /**
   * Gives every occurrence of the series, past ones included, `notes`
   * (decision 5), bumping `version` on each that changes.
   */
  async shareNotes(
    ex: Executor,
    taskSeriesId: string,
    notes: string,
  ): Promise<void> {
    await ex
      .update(tasks)
      .set({ notes, version: sql`${tasks.version} + 1` })
      .where(and(eq(tasks.taskSeriesId, taskSeriesId), ne(tasks.notes, notes)));
  }

  /**
   * What stopping a series after `after` does to the occurrences it has
   * already issued past that day: open ones are deleted, since they existed
   * only because the series did, and done ones stay where they are as
   * one-offs. Returns the done ones' dates.
   */
  async dropLaterCopies(
    ex: Executor,
    taskSeriesId: string,
    after: string,
  ): Promise<string[]> {
    const later = and(
      eq(tasks.taskSeriesId, taskSeriesId),
      gt(tasks.date, after),
    );
    await ex.delete(tasks).where(and(later, eq(tasks.done, false)));
    const kept = await ex
      .update(tasks)
      .set({ taskSeriesId: null, version: sql`${tasks.version} + 1` })
      .where(later)
      .returning({ date: tasks.date });
    return kept.map((row) => row.date);
  }

  /**
   * Deletes every occurrence of the series dated `from` or later, done or
   * open, and `id` wherever it is. Their days' records stay in the ledger.
   */
  async deleteSeriesFrom(
    ex: Executor,
    taskSeriesId: string,
    from: string,
    id: string,
  ): Promise<void> {
    await ex
      .delete(tasks)
      .where(
        or(
          eq(tasks.id, id),
          and(eq(tasks.taskSeriesId, taskSeriesId), gte(tasks.date, from)),
        ),
      );
  }

  /**
   * Makes the series' occurrences dated `from` or later occurrences of
   * `toSeriesId` instead, where they are, when their block splits.
   */
  async relinkSeriesFrom(
    ex: Executor,
    taskSeriesId: string,
    from: string,
    toSeriesId: string,
  ): Promise<void> {
    await ex
      .update(tasks)
      .set({ taskSeriesId: toSeriesId })
      .where(and(eq(tasks.taskSeriesId, taskSeriesId), gte(tasks.date, from)));
  }

  /** Removes what `day` recorded for the task, if anything. */
  async clearDay(ex: Executor, taskId: string, day: string): Promise<void> {
    await ex
      .delete(taskLedgerEntries)
      .where(
        and(
          eq(taskLedgerEntries.taskId, taskId),
          eq(taskLedgerEntries.day, day),
        ),
      );
  }

  /**
   * The user's tasks dated from `from` to `to`, both included, each with its
   * series, in no particular order. Uses `idx_tasks_user_id_date`.
   */
  findBetween(
    ex: Executor,
    userId: string,
    from: string,
    to: string,
  ): Promise<TaskWithSeries[]> {
    return ex
      .select({ task: tasks, series: taskSeries })
      .from(tasks)
      .leftJoin(taskSeries, eq(taskSeries.id, tasks.taskSeriesId))
      .where(
        and(
          eq(tasks.userId, userId),
          gte(tasks.date, from),
          lte(tasks.date, to),
        ),
      );
  }

  /**
   * The caller's open tasks whose reminder falls from `from` to `to`, both
   * included, in no particular order. Keyed on the reminder's date, not the
   * task's. Uses `idx_tasks_user_id_reminder_date`, whose predicate `NOT done`
   * repeats here so the planner can match it.
   */
  /**
   * What the user's ledger recorded from `from` to `to`, both included (DSH-02).
   * `incomplete` counts missed days too. A deleted task's days still count:
   * its entries outlive it.
   */
  async countLedgerBetween(
    ex: Executor,
    userId: string,
    from: string,
    to: string,
  ): Promise<{ completed: number; incomplete: number }> {
    const [counts] = await ex
      .select({
        completed: sql<number>`count(*) FILTER (WHERE ${taskLedgerEntries.outcome} = 'completed')::int`,
        incomplete: sql<number>`count(*) FILTER (WHERE ${taskLedgerEntries.outcome} <> 'completed')::int`,
      })
      .from(taskLedgerEntries)
      .where(
        and(
          eq(taskLedgerEntries.userId, userId),
          gte(taskLedgerEntries.day, from),
          lte(taskLedgerEntries.day, to),
        ),
      );
    return counts ?? { completed: 0, incomplete: 0 };
  }

  /**
   * DSH-05: the user's most carried tasks among those active from `from` to
   * `to` (decision 4). A task is active if a day of the period recorded it
   * incomplete or missed, or it sits on one of those days now. Only tasks
   * carried at least once rank, as in the app. Ties go by title, lower-cased
   * and compared by code unit as `compareTasks` does, then by id.
   */
  findMostCarried(
    ex: Executor,
    userId: string,
    from: string,
    to: string,
    limit: number,
  ): Promise<TaskWithSeries[]> {
    const carriedInPeriod = ex
      .select({ taskId: taskLedgerEntries.taskId })
      .from(taskLedgerEntries)
      .where(
        and(
          eq(taskLedgerEntries.userId, userId),
          gte(taskLedgerEntries.day, from),
          lte(taskLedgerEntries.day, to),
          ne(taskLedgerEntries.outcome, 'completed'),
        ),
      );
    return ex
      .select({ task: tasks, series: taskSeries })
      .from(tasks)
      .leftJoin(taskSeries, eq(taskSeries.id, tasks.taskSeriesId))
      .where(
        and(
          eq(tasks.userId, userId),
          gt(tasks.carryCount, 0),
          or(
            and(gte(tasks.date, from), lte(tasks.date, to)),
            inArray(tasks.id, carriedInPeriod),
          ),
        ),
      )
      .orderBy(
        desc(tasks.carryCount),
        sql`lower(${tasks.title}) COLLATE "C"`,
        tasks.id,
      )
      .limit(limit);
  }

  findOpenRemindersBetween(
    ex: Executor,
    userId: string,
    from: string,
    to: string,
  ): Promise<TaskRow[]> {
    return ex
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.userId, userId),
          not(tasks.done),
          eq(tasks.missed, false),
          gte(tasks.reminderDate, from),
          lte(tasks.reminderDate, to),
        ),
      );
  }
}
