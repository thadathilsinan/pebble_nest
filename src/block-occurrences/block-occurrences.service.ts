import { Inject, Injectable } from '@nestjs/common';
import type { Caller } from '../auth/caller';
import { assertOccursOn } from '../blocks/block-occurrence';
import { recurrenceOf } from '../blocks/blocks.mapper';
import { BlocksRepository } from '../blocks/blocks.repository';
import { addDays, daysBetween } from '../calendar/local-date';
import { firstOccurrenceFrom } from '../calendar/recurrence';
import { DB, type Db, type Executor } from '../core/database/database.module';
import type { BlockSeriesRow, TaskRow } from '../core/database/schema';
import { TasksRepository } from '../tasks/tasks.repository';
import { todayFor } from '../users/today';
import { UsersRepository } from '../users/users.repository';
import { BlockOccurrencesRepository } from './block-occurrences.repository';
import type { DeleteScope } from './dto/delete-occurrence.dto';

/**
 * `POST …/skip`'s and `DELETE …`'s body: what the UI tells the user moved.
 */
export interface MovedTasks {
  movedTaskCount: number;
}

@Injectable()
export class BlockOccurrencesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly occurrences: BlockOccurrencesRepository,
    private readonly blocks: BlocksRepository,
    private readonly tasks: TasksRepository,
    private readonly users: UsersRepository,
  ) {}

  /**
   * Skips one occurrence (BLK-07). Its open tasks move to that day's general
   * list, and its done tasks stay where they were done. An open task on a
   * day that has already closed is carried forward at once, as `/move`
   * carries one moved there (decision 26): to today's general list, with one
   * carry and one `incomplete` entry per closed day.
   *
   * No `version`: skipped is an absolute value, so the last write wins, and
   * skipping again moves whatever has arrived since, normally nothing. It
   * does not read the session (decision 16).
   */
  async skip(
    caller: Caller,
    seriesId: string,
    date: string,
  ): Promise<MovedTasks> {
    const today = todayFor(await this.users.findById(this.db, caller.userId));

    return this.db.transaction(async (tx) => {
      assertOccursOn(
        await this.blocks.findOccurrence(tx, caller.userId, seriesId, date, {
          lock: true,
        }),
        date,
      );
      await this.occurrences.skip(tx, caller.userId, seriesId, date);

      const open = await this.tasks.findOpenInOccurrenceForUpdate(
        tx,
        caller.userId,
        seriesId,
        date,
      );
      return { movedTaskCount: await this.toGeneralList(tx, open, today) };
    });
  }

  /**
   * Un-skips one occurrence (BLK-08). Tasks the skip moved stay where they
   * went. Un-skipping an occurrence that isn't skipped changes nothing.
   *
   * It reads no user row, so a token whose account is gone gets the 404 its
   * vanished series gives. It does not read the session (decision 16).
   */
  async unskip(caller: Caller, seriesId: string, date: string): Promise<void> {
    assertOccursOn(
      await this.blocks.findOccurrence(this.db, caller.userId, seriesId, date),
      date,
    );
    await this.occurrences.unskip(this.db, seriesId, date);
  }

  /**
   * Deletes one occurrence, or with `series` the whole series from today on
   * (decision 3) and the occurrence named too, even a past one (decision 29).
   * A block that doesn't repeat is deleted outright, whatever the scope.
   *
   * Every task, open and done, in a deleted occurrence moves to its own
   * day's general list (BLK-10), and an open one on a closed day carries on
   * to today's, as `skip` carries it. A series with no occurrence left before
   * today is deleted rather than ended.
   *
   * No `version`: the last write wins, and a retry finds the occurrence gone,
   * a 404. It does not read the session (decision 16).
   */
  async delete(
    caller: Caller,
    seriesId: string,
    date: string,
    scope: DeleteScope,
  ): Promise<MovedTasks> {
    const today = todayFor(await this.users.findById(this.db, caller.userId));

    return this.db.transaction(async (tx) => {
      const found = await this.blocks.findOccurrence(
        tx,
        caller.userId,
        seriesId,
        date,
        { lock: true },
      );
      assertOccursOn(found, date);
      const { series } = found;
      const repeats = series.recurrenceKind !== 'none';
      const wholeSeries = scope === 'series' && repeats;

      const tasks = await this.tasks.findInSeriesForUpdate(
        tx,
        caller.userId,
        seriesId,
        { date, from: wholeSeries ? today : undefined },
      );
      // Before the series goes, since its foreign key would only unset the
      // tasks' block, without a version bump or a carry.
      const movedTaskCount = await this.toGeneralList(tx, tasks, today);

      if (!repeats || (wholeSeries && !keepsHistory(series, date, today))) {
        await this.blocks.delete(tx, seriesId);
      } else if (!wholeSeries) {
        await this.occurrences.markDeleted(tx, caller.userId, seriesId, date);
      } else {
        await this.blocks.endBy(tx, seriesId, addDays(today, -1));
        if (date < today) {
          await this.occurrences.markDeleted(tx, caller.userId, seriesId, date);
        }
      }
      return { movedTaskCount };
    });
  }

  /**
   * Moves `tasks`, locked by the caller, to the general list of the day each
   * sits on, and counts them. An open task on a day that has closed carries
   * on to today's instead, with one carry and one `incomplete` entry per
   * closed day, as `/move` carries one (decision 26).
   */
  private async toGeneralList(
    tx: Executor,
    tasks: TaskRow[],
    today: string,
  ): Promise<number> {
    for (const task of tasks) {
      if (task.done || task.date >= today) {
        await this.tasks.move(tx, task.id, {
          date: task.date,
          blockSeriesId: null,
          carryDays: 0,
        });
        continue;
      }
      const carried = await this.tasks.move(tx, task.id, {
        date: today,
        blockSeriesId: null,
        carryDays: daysBetween(task.date, today),
      });
      await this.tasks.recordIncomplete(
        tx,
        carried,
        task.date,
        addDays(today, -1),
      );
    }
    return tasks.length;
  }
}

/**
 * Whether the series keeps an occurrence before today once the one on
 * `date` is deleted with the rest of the series.
 */
function keepsHistory(
  series: BlockSeriesRow,
  date: string,
  today: string,
): boolean {
  const recurrence = recurrenceOf(series);
  let first = firstOccurrenceFrom(
    recurrence,
    series.anchorDate,
    series.anchorDate,
  );
  if (first === date) {
    first = firstOccurrenceFrom(
      recurrence,
      series.anchorDate,
      addDays(date, 1),
    );
  }
  return first !== null && first < today;
}
