import { Inject, Injectable } from '@nestjs/common';
import type { Caller } from '../auth/caller';
import { addDays } from '../calendar/local-date';
import { occursOn } from '../calendar/recurrence';
import {
  recurrenceOf,
  toBlockOccurrence,
  type BlockOccurrence,
} from '../blocks/blocks.mapper';
import { BlocksRepository } from '../blocks/blocks.repository';
import { DB, type Db } from '../core/database/database.module';
import type { BlockSeriesRow } from '../core/database/schema';

/** `Day` in `docs/api-plan.md` §3. */
export interface Day {
  date: string;
  /** Yesterday's midnight-crossing tails first, then by start time. */
  blocks: BlockOccurrence[];
  // Tasks have no table yet, so every general list is truthfully empty, as
  // every block's `tasks` is.
  generalList: never[];
}

@Injectable()
export class DaysService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly blocks: BlocksRepository,
  ) {}

  /**
   * Every day from `from` to `to`, both included, from one read of the
   * caller's series. It does not read the session (decision 16).
   */
  async list(caller: Caller, from: string, to: string): Promise<Day[]> {
    // The day before `from`, for the tails of blocks that began then.
    const rows = await this.blocks.findActiveBetween(
      this.db,
      caller.userId,
      addDays(from, -1),
      to,
    );

    const days: Day[] = [];
    for (let date = from; date <= to; date = addDays(date, 1)) {
      days.push({ date, blocks: blocksOn(rows, date), generalList: [] });
    }
    return days;
  }
}

/**
 * The occurrences that start on `date`, plus the tails of those that started
 * the day before and cross midnight (BLK-04). A block ending exactly at
 * midnight has no tail: nothing of it falls on the next day.
 */
function blocksOn(rows: BlockSeriesRow[], date: string): BlockOccurrence[] {
  const yesterday = addDays(date, -1);
  const out: BlockOccurrence[] = [];

  for (const row of rows) {
    const recurrence = recurrenceOf(row);
    if (
      crossesMidnight(row) &&
      row.endMin > 0 &&
      occursOn(recurrence, row.anchorDate, yesterday)
    ) {
      out.push(toBlockOccurrence(row, yesterday, true));
    }
    if (occursOn(recurrence, row.anchorDate, date)) {
      out.push(toBlockOccurrence(row, date));
    }
  }

  // Lanes are the client's job; this order only has to be stable.
  return out.sort(
    (a, b) =>
      Number(b.continuedFromPreviousDay) - Number(a.continuedFromPreviousDay) ||
      a.startMin - b.startMin ||
      compare(a.name, b.name) ||
      compare(a.seriesId, b.seriesId),
  );
}

/** `end_min <= start_min`, as the schema reads it; equal is a full day. */
function crossesMidnight(row: BlockSeriesRow): boolean {
  return row.endMin <= row.startMin;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
