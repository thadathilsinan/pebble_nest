import { Injectable } from '@nestjs/common';
import {
  and,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
} from 'drizzle-orm';
import type { Executor } from '../core/database/database.module';
import {
  taskSeries,
  taskSeriesIssuedDates,
  tasks,
  type TaskSeriesRow,
} from '../core/database/schema';

/** What editing a series' template can change. */
export type TaskSeriesChanges = Partial<
  Pick<TaskSeriesRow, 'title' | 'notes' | 'reminderDayOffset' | 'reminderMin'>
>;

/** The columns a new series is written with. */
export type NewTaskSeries = Pick<
  TaskSeriesRow,
  | 'userId'
  | 'blockSeriesId'
  | 'anchorDate'
  | 'recurrenceKind'
  | 'weekdays'
  | 'monthDays'
  | 'until'
  | 'title'
  | 'notes'
  | 'reminderDayOffset'
  | 'reminderMin'
>;

@Injectable()
export class TaskSeriesRepository {
  /**
   * Inserts a series and records its anchor as issued, along with `issued`:
   * dates that already have an occurrence it must not issue again.
   */
  async create(
    ex: Executor,
    values: NewTaskSeries,
    issued: string[] = [],
  ): Promise<TaskSeriesRow> {
    const [row] = await ex.insert(taskSeries).values(values).returning();
    if (row === undefined)
      throw new Error('task series insert returned no row');
    await ex.insert(taskSeriesIssuedDates).values(
      [...new Set([row.anchorDate, ...issued])].map((date) => ({
        taskSeriesId: row.id,
        date,
      })),
    );
    return row;
  }

  /**
   * One of the user's series, locked until the transaction ends. Taken after
   * the lock on the task it is reached through, so two edits through
   * different occurrences take turns.
   */
  async findByIdForUpdate(
    ex: Executor,
    userId: string,
    id: string,
  ): Promise<TaskSeriesRow | null> {
    const [row] = await ex
      .select()
      .from(taskSeries)
      .where(and(eq(taskSeries.userId, userId), eq(taskSeries.id, id)))
      .limit(1)
      .for('update');
    return row ?? null;
  }

  /** Writes `changes` to the series' template. The caller holds its lock. */
  async update(
    ex: Executor,
    id: string,
    changes: TaskSeriesChanges,
  ): Promise<TaskSeriesRow> {
    const [row] = await ex
      .update(taskSeries)
      .set(changes)
      .where(eq(taskSeries.id, id))
      .returning();
    if (row === undefined) throw new Error('task series vanished while locked');
    return row;
  }

  /**
   * Ends the series on `endedOn`, unless it already ends by then: it issues
   * nothing after that day.
   */
  async endBy(ex: Executor, id: string, endedOn: string): Promise<void> {
    await ex
      .update(taskSeries)
      .set({ endedOn })
      .where(
        and(
          eq(taskSeries.id, id),
          or(isNull(taskSeries.endedOn), gt(taskSeries.endedOn, endedOn)),
        ),
      );
  }

  /**
   * The series repeating with the block, locked until the transaction ends,
   * in id order. Uses `idx_task_series_block_series_id`.
   */
  findOnBlockForUpdate(
    ex: Executor,
    blockSeriesId: string,
  ): Promise<TaskSeriesRow[]> {
    return ex
      .select()
      .from(taskSeries)
      .where(eq(taskSeries.blockSeriesId, blockSeriesId))
      .orderBy(taskSeries.id)
      .for('update');
  }

  /** Moves the whole series to another block. */
  async repoint(
    ex: Executor,
    id: string,
    blockSeriesId: string,
  ): Promise<void> {
    await ex
      .update(taskSeries)
      .set({ blockSeriesId })
      .where(eq(taskSeries.id, id));
  }

  /**
   * Re-anchors the series on `anchorDate`, marking it issued, as its
   * block's first occurrence moves there with its tasks.
   */
  async reanchor(ex: Executor, id: string, anchorDate: string): Promise<void> {
    await ex
      .update(taskSeries)
      .set({ anchorDate })
      .where(eq(taskSeries.id, id));
    await ex
      .insert(taskSeriesIssuedDates)
      .values({ taskSeriesId: id, date: anchorDate })
      .onConflictDoNothing();
  }

  /** The dates the series has issued from `from` on. */
  async findIssuedFrom(
    ex: Executor,
    id: string,
    from: string,
  ): Promise<string[]> {
    const rows = await ex
      .select({ date: taskSeriesIssuedDates.date })
      .from(taskSeriesIssuedDates)
      .where(
        and(
          eq(taskSeriesIssuedDates.taskSeriesId, id),
          gte(taskSeriesIssuedDates.date, from),
        ),
      );
    return rows.map((row) => row.date);
  }

  /**
   * Deletes the series and the dates it issued. Its remaining tasks become
   * one-offs.
   */
  async delete(ex: Executor, id: string): Promise<void> {
    await ex.delete(taskSeries).where(eq(taskSeries.id, id));
  }

  /** One of the user's series, or null. */
  async findById(
    ex: Executor,
    userId: string,
    id: string,
  ): Promise<TaskSeriesRow | null> {
    const [row] = await ex
      .select()
      .from(taskSeries)
      .where(and(eq(taskSeries.userId, userId), eq(taskSeries.id, id)))
      .limit(1);
    return row ?? null;
  }

  /**
   * The user's series that may have an occurrence from `from` to `to`, both
   * included: begun by `to`, and neither ended nor past `until` before
   * `from`. Which days each lands on is `landsOn`'s job. Uses
   * `idx_task_series_user_id`.
   */
  findActiveBetween(
    ex: Executor,
    userId: string,
    from: string,
    to: string,
  ): Promise<TaskSeriesRow[]> {
    return ex
      .select()
      .from(taskSeries)
      .where(
        and(
          eq(taskSeries.userId, userId),
          lte(taskSeries.anchorDate, to),
          or(isNull(taskSeries.endedOn), gte(taskSeries.endedOn, from)),
          or(isNull(taskSeries.until), gte(taskSeries.until, from)),
        ),
      );
  }

  /**
   * The user's series with a reminder that are still issuing, for NTF-03.
   * Uses `idx_task_series_user_id`.
   */
  findWithReminders(ex: Executor, userId: string): Promise<TaskSeriesRow[]> {
    return ex
      .select()
      .from(taskSeries)
      .where(
        and(
          eq(taskSeries.userId, userId),
          isNotNull(taskSeries.reminderDayOffset),
        ),
      );
  }

  /**
   * Which of `seriesIds` have issued their occurrence on which dates from
   * `from` to `to`, as `seriesId/date` keys.
   */
  async findIssuedBetween(
    ex: Executor,
    seriesIds: string[],
    from: string,
    to: string,
  ): Promise<Set<string>> {
    if (seriesIds.length === 0) return new Set();
    const rows = await ex
      .select()
      .from(taskSeriesIssuedDates)
      .where(
        and(
          inArray(taskSeriesIssuedDates.taskSeriesId, seriesIds),
          gte(taskSeriesIssuedDates.date, from),
          lte(taskSeriesIssuedDates.date, to),
        ),
      );
    return new Set(rows.map((row) => issuedKey(row.taskSeriesId, row.date)));
  }

  /**
   * Issues each series' occurrence on its date: marks the date issued and
   * writes the task from the series as it now stands. A date already issued,
   * even by a racing request, is left alone, so each occurrence is written
   * once; the loser of a race waits on the winner's key and then skips it.
   * A series ended before the date since it was read issues nothing there.
   *
   * One statement over a JSON array rather than a row per bind parameter, so
   * a long range of a daily series stays one round trip.
   */
  async issue(
    ex: Executor,
    occurrences: { seriesId: string; date: string }[],
  ): Promise<void> {
    if (occurrences.length === 0) return;
    await ex.execute(sql`
      WITH issued AS (
        INSERT INTO ${taskSeriesIssuedDates} (task_series_id, date)
        SELECT s.id, o.date
        FROM jsonb_to_recordset(${JSON.stringify(occurrences)}::jsonb)
          AS o("seriesId" uuid, date date)
        JOIN ${taskSeries} s ON s.id = o."seriesId"
        WHERE s.ended_on IS NULL OR o.date <= s.ended_on
        ON CONFLICT DO NOTHING
        RETURNING task_series_id, date
      )
      INSERT INTO ${tasks} (user_id, task_series_id, block_series_id, date,
        title, notes, reminder_date, reminder_min)
      SELECT s.user_id, s.id, s.block_series_id, i.date, s.title, s.notes,
        i.date + s.reminder_day_offset, s.reminder_min
      FROM issued i
      JOIN ${taskSeries} s ON s.id = i.task_series_id
    `);
  }
}

/** A series' date in `findIssuedBetween`'s set. */
export function issuedKey(seriesId: string, date: string): string {
  return `${seriesId}/${date}`;
}
