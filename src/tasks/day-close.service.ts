import { Inject, Injectable } from '@nestjs/common';
import { addDays, todayIn } from '../calendar/local-date';
import { DB, type Db } from '../core/database/database.module';
import type { TaskSeriesRow } from '../core/database/schema';
import { FALLBACK_TIME_ZONE } from '../users/today';
import { UsersRepository } from '../users/users.repository';
import { TaskSeriesRepository } from './task-series.repository';
import { TaskSeriesService } from './task-series.service';
import { TasksRepository } from './tasks.repository';

/**
 * How far a user's days have closed, and the zone their today is read in:
 * enough to tell whether a new day has closed since, without a read.
 */
export interface ClosedState {
  closedThrough: string;
  timeZone: string;
}

/**
 * The day-end close (api-plan §7): settles every open task left on a day
 * that has closed, as though a job had run at each of the user's local
 * midnights. It runs lazily, before the user's first request after one
 * (decision 38), and nothing can tell the difference, since every read
 * goes through the API.
 */
@Injectable()
export class DayCloseService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly users: UsersRepository,
    private readonly tasks: TasksRepository,
    private readonly taskSeries: TaskSeriesRepository,
    private readonly series: TaskSeriesService,
  ) {}

  /**
   * Closes every day before the user's today not closed yet, in one
   * transaction. The days since the last close issue the occurrences their
   * repeating tasks have, so a day nobody read still records them. Then
   * each open task on a closed day is settled: carried to today's general
   * list with an `incomplete` entry per day it passed through (TSK-06/07),
   * or recorded missed on the day before its series comes round again
   * (REC-06/07).
   *
   * The user row is locked first, so requests arriving together take turns
   * and all but the first find nothing left to close. `closed_through` only
   * moves forward, so a day repeated by travel west closes once.
   *
   * Tasks are settled wherever they sit before today, not only on the days
   * this close covers: an occurrence issued open on a closed day by a read
   * (decision 35) is settled by the next close, as the day-end job would.
   *
   * Null when the account is gone.
   */
  async close(userId: string): Promise<ClosedState | null> {
    return this.db.transaction(async (tx) => {
      const user = await this.users.findByIdForUpdate(tx, userId);
      if (user === null) return null;

      const timeZone = user.timeZone ?? FALLBACK_TIME_ZONE;
      const today = todayIn(timeZone);
      const yesterday = addDays(today, -1);
      if (user.closedThrough !== null && user.closedThrough >= yesterday) {
        return { closedThrough: user.closedThrough, timeZone };
      }

      await this.series.issueClosed(
        tx,
        userId,
        user.closedThrough === null ? null : addDays(user.closedThrough, 1),
        yesterday,
      );

      const seriesById = new Map<string, TaskSeriesRow | null>();
      for (const task of await this.tasks.findUnsettledBeforeForUpdate(
        tx,
        userId,
        today,
      )) {
        const seriesId = task.taskSeriesId;
        let series: TaskSeriesRow | null = null;
        if (seriesId !== null) {
          if (!seriesById.has(seriesId)) {
            seriesById.set(
              seriesId,
              await this.taskSeries.findById(tx, userId, seriesId),
            );
          }
          series = seriesById.get(seriesId)!;
        }

        const settled = await this.series.settleClosed(
          tx,
          userId,
          series,
          task.date,
          today,
        );
        const carried = await this.tasks.carry(tx, task.id, {
          date: settled.date,
          days: settled.carryDays,
          missed: settled.missed,
        });
        await this.tasks.recordSettled(tx, carried, task.date, settled, today);
      }

      await this.users.setClosedThrough(tx, userId, yesterday);
      return { closedThrough: yesterday, timeZone };
    });
  }
}
