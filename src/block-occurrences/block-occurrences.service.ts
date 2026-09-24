import { Inject, Injectable } from '@nestjs/common';
import type { Caller } from '../auth/caller';
import { assertOccursOn } from '../blocks/block-occurrence';
import { BlocksRepository } from '../blocks/blocks.repository';
import { addDays, daysBetween } from '../calendar/local-date';
import { DB, type Db } from '../core/database/database.module';
import { TasksRepository } from '../tasks/tasks.repository';
import { todayFor } from '../users/today';
import { UsersRepository } from '../users/users.repository';
import { BlockOccurrencesRepository } from './block-occurrences.repository';

/** `POST …/skip`'s body: what the UI tells the user moved. */
export interface SkipResult {
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
  ): Promise<SkipResult> {
    const today = todayFor(await this.users.findById(this.db, caller.userId));

    return this.db.transaction(async (tx) => {
      assertOccursOn(
        await this.blocks.findById(tx, caller.userId, seriesId),
        date,
      );
      await this.occurrences.skip(tx, caller.userId, seriesId, date);

      const open = await this.tasks.findOpenInOccurrenceForUpdate(
        tx,
        caller.userId,
        seriesId,
        date,
      );
      for (const task of open) {
        if (date >= today) {
          await this.tasks.move(tx, task.id, {
            date,
            blockSeriesId: null,
            carryDays: 0,
          });
          continue;
        }
        const carried = await this.tasks.move(tx, task.id, {
          date: today,
          blockSeriesId: null,
          carryDays: daysBetween(date, today),
        });
        await this.tasks.recordIncomplete(
          tx,
          carried,
          date,
          addDays(today, -1),
        );
      }
      return { movedTaskCount: open.length };
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
      await this.blocks.findById(this.db, caller.userId, seriesId),
      date,
    );
    await this.occurrences.unskip(this.db, seriesId, date);
  }
}
