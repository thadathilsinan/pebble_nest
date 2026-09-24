import { Injectable } from '@nestjs/common';
import { BlocksRepository } from '../blocks/blocks.repository';
import { recurrenceOf } from '../blocks/blocks.mapper';
import { addDays } from '../calendar/local-date';
import { occursOn } from '../calendar/recurrence';
import type { Executor } from '../core/database/database.module';
import {
  landsOn,
  nextOccurrenceAfter,
  type BlockOccursOn,
  type SeriesDays,
} from './task-series';
import { issuedKey, TaskSeriesRepository } from './task-series.repository';

/**
 * Issuing repeating tasks' occurrences, and finding where a series goes
 * next. The server creates occurrences as their dates are read (api-plan
 * §1), so the readers of a day's tasks call `issueBetween` first.
 */
@Injectable()
export class TaskSeriesService {
  constructor(
    private readonly series: TaskSeriesRepository,
    private readonly blocks: BlocksRepository,
  ) {}

  /**
   * Writes every occurrence the user's series have from `from` to `to`, both
   * included, that has not been issued yet. A closed day's occurrence is
   * issued open like any other, and left for the day-end job to settle.
   *
   * `blockOccursOn` answers for the user's blocks over the same range, from
   * what the caller has already read of them. It reads, and writes nothing,
   * when every occurrence is already there.
   */
  async issueBetween(
    ex: Executor,
    userId: string,
    from: string,
    to: string,
    blockOccursOn: BlockOccursOn,
  ): Promise<void> {
    const rows = await this.series.findActiveBetween(ex, userId, from, to);
    if (rows.length === 0) return;

    const issued = await this.series.findIssuedBetween(
      ex,
      rows.map((row) => row.id),
      from,
      to,
    );
    const due: { seriesId: string; date: string }[] = [];
    for (const row of rows) {
      for (let date = from; date <= to; date = addDays(date, 1)) {
        if (
          !issued.has(issuedKey(row.id, date)) &&
          landsOn(row, date, blockOccursOn)
        ) {
          due.push({ seriesId: row.id, date });
        }
      }
    }
    await this.series.issue(ex, due);
  }

  /**
   * The series' first occurrence after `date`, for REC-06, or null when
   * none is coming. A series in a block reads that block, and which of its
   * later occurrences are deleted.
   */
  async nextAfter(
    ex: Executor,
    userId: string,
    series: SeriesDays,
    date: string,
  ): Promise<string | null> {
    return nextOccurrenceAfter(
      series,
      date,
      await this.blockOccursOnAfter(ex, userId, series.blockSeriesId, date),
    );
  }

  /** `BlockOccursOn` for one block's occurrences after `date`. */
  private async blockOccursOnAfter(
    ex: Executor,
    userId: string,
    blockSeriesId: string | null,
    date: string,
  ): Promise<BlockOccursOn> {
    if (blockSeriesId === null) return () => false;
    const block = await this.blocks.findById(ex, userId, blockSeriesId);
    if (block === null) return () => false;
    const deleted = await this.blocks.findDeletedDatesAfter(ex, block.id, date);
    const recurrence = recurrenceOf(block);
    return (_id, day) =>
      occursOn(recurrence, block.anchorDate, day) && !deleted.has(day);
  }
}
