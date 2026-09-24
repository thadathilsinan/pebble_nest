import { Injectable } from '@nestjs/common';
import { and, eq, gte, lte, sql } from 'drizzle-orm';
import type { Executor } from '../core/database/database.module';
import {
  taskLedgerEntries,
  tasks,
  type TaskRow,
} from '../core/database/schema';

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
> & { idempotencyKey?: string };

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
    `);
  }

  /**
   * The user's tasks dated from `from` to `to`, both included, in no
   * particular order. Uses `idx_tasks_user_id_date`.
   */
  findBetween(
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
          gte(tasks.date, from),
          lte(tasks.date, to),
        ),
      );
  }
}
