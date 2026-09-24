import { Injectable } from '@nestjs/common';
import { BlocksRepository } from '../blocks/blocks.repository';
import { recurrenceOf } from '../blocks/blocks.mapper';
import { addDays } from '../calendar/local-date';
import { occursOn } from '../calendar/recurrence';
import type { Executor } from '../core/database/database.module';
import type { TaskSeriesRow } from '../core/database/schema';
import {
  landsOn,
  nextOccurrenceAfter,
  type BlockOccursOn,
  type SeriesDays,
} from './task-series';
import { issuedKey, TaskSeriesRepository } from './task-series.repository';
import { TasksRepository } from './tasks.repository';

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
    private readonly tasks: TasksRepository,
  ) {}

  /**
   * Writes every occurrence the user's series have from `from` to `to`, both
   * included, that has not been issued yet. A closed day's occurrence is
   * issued open like any other, and left for the day-end job to settle.
   *
   * `blockOccursOn` answers for the user's blocks over the same range, from
   * what the caller has already read of them; without it, they are read
   * here. It reads, and writes nothing, when every occurrence is already
   * there.
   */
  async issueBetween(
    ex: Executor,
    userId: string,
    from: string,
    to: string,
    blockOccursOn?: BlockOccursOn,
  ): Promise<void> {
    const rows = await this.series.findActiveBetween(ex, userId, from, to);
    await this.issue(ex, rows, from, to, blockOccursOn);
  }

  /**
   * Writes the occurrences whose reminder falls from `from` to `to`, both
   * included, that have not been issued yet, for NTF-03. A reminder can be
   * days from its occurrence's date, so each series is issued over the
   * dates its reminders from `from` to `to` belong to.
   */
  async issueRemindersBetween(
    ex: Executor,
    userId: string,
    from: string,
    to: string,
  ): Promise<void> {
    const byOffset = new Map<number, TaskSeriesRow[]>();
    for (const row of await this.series.findWithReminders(ex, userId)) {
      const offset = row.reminderDayOffset!;
      byOffset.set(offset, [...(byOffset.get(offset) ?? []), row]);
    }
    for (const [offset, rows] of byOffset) {
      await this.issue(ex, rows, addDays(from, -offset), addDays(to, -offset));
    }
  }

  /** `issueBetween` for these series. */
  private async issue(
    ex: Executor,
    rows: TaskSeriesRow[],
    from: string,
    to: string,
    blockOccursOn?: BlockOccursOn,
  ): Promise<void> {
    if (rows.length === 0) return;

    const issued = await this.series.findIssuedBetween(
      ex,
      rows.map((row) => row.id),
      from,
      to,
    );
    const occursOn =
      blockOccursOn ??
      (rows.some((row) => row.blockSeriesId !== null)
        ? await this.blockOccursOnBetween(ex, rows[0]!.userId, from, to)
        : () => false);
    const due: { seriesId: string; date: string }[] = [];
    for (const row of rows) {
      for (let date = from; date <= to; date = addDays(date, 1)) {
        if (
          !issued.has(issuedKey(row.id, date)) &&
          landsOn(row, date, occursOn)
        ) {
          due.push({ seriesId: row.id, date });
        }
      }
    }
    await this.series.issue(ex, due);
  }

  /** `BlockOccursOn` for the user's blocks from `from` to `to`. */
  private async blockOccursOnBetween(
    ex: Executor,
    userId: string,
    from: string,
    to: string,
  ): Promise<BlockOccursOn> {
    const [rows, deleted] = await Promise.all([
      this.blocks.findActiveBetween(ex, userId, from, to),
      this.blocks.findDeletedBetween(ex, userId, from, to),
    ]);
    const byId = new Map(rows.map((row) => [row.id, row]));
    return (blockSeriesId, date) => {
      const row = byId.get(blockSeriesId);
      return (
        row !== undefined &&
        occursOn(recurrenceOf(row), row.anchorDate, date) &&
        !deleted.has(`${blockSeriesId}/${date}`)
      );
    };
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

  /**
   * The block split at `date` into `nextBlockId` (REC-04): the tasks
   * repeating with it carry on with the new block from `date`, as in the
   * app. A series begun on or after `date` moves across whole. One begun
   * before it ends the day before, and a copy of it, anchored on `date` and
   * knowing which dates it had already issued, takes its occurrences from
   * `date` on. A new block that doesn't repeat takes their repeats away.
   *
   * The caller has already moved the tasks, and holds their locks.
   */
  async followSplit(
    ex: Executor,
    blockId: string,
    nextBlockId: string,
    date: string,
    repeats: boolean,
  ): Promise<void> {
    for (const row of await this.series.findOnBlockForUpdate(ex, blockId)) {
      if (row.endedOn !== null && row.endedOn < date) continue;
      if (row.anchorDate >= date) {
        await this.series.repoint(ex, row.id, nextBlockId);
        continue;
      }
      const issued = await this.series.findIssuedFrom(ex, row.id, date);
      await this.series.endBy(ex, row.id, addDays(date, -1));
      const next = await this.series.create(
        ex,
        {
          userId: row.userId,
          blockSeriesId: nextBlockId,
          anchorDate: date,
          recurrenceKind: 'none',
          weekdays: [],
          monthDays: [],
          until: null,
          title: row.title,
          notes: row.notes,
          reminderDayOffset: row.reminderDayOffset,
          reminderMin: row.reminderMin,
        },
        issued,
      );
      if (row.endedOn !== null)
        await this.series.endBy(ex, next.id, row.endedOn);
      await this.tasks.relinkSeriesFrom(ex, row.id, date, next.id);
    }
    if (!repeats) await this.endWithBlock(ex, nextBlockId, null);
  }

  /**
   * The block's first occurrence moved from `from` to `to` with its tasks:
   * the series anchored there move with it, as in the app.
   */
  async followHeadMove(
    ex: Executor,
    blockId: string,
    from: string,
    to: string,
  ): Promise<void> {
    for (const row of await this.series.findOnBlockForUpdate(ex, blockId)) {
      if (row.anchorDate === from) await this.series.reanchor(ex, row.id, to);
    }
  }

  /**
   * The block stops repeating after `lastDay`, or, with null, altogether:
   * the tasks repeating with it stop too. Their open occurrences already
   * issued for later days are deleted, since they existed only because the
   * series did, and done ones stay as one-offs. A series with nothing left
   * on or before `lastDay` is deleted, and its remaining tasks become
   * one-offs.
   *
   * The caller holds the locks on the block's tasks.
   */
  async endWithBlock(
    ex: Executor,
    blockId: string,
    lastDay: string | null,
  ): Promise<void> {
    for (const row of await this.series.findOnBlockForUpdate(ex, blockId)) {
      if (lastDay === null || row.anchorDate > lastDay) {
        if (lastDay !== null) {
          await this.tasks.dropLaterCopies(ex, row.id, lastDay);
        }
        await this.series.delete(ex, row.id);
        continue;
      }
      await this.series.endBy(ex, row.id, lastDay);
      await this.tasks.dropLaterCopies(ex, row.id, lastDay);
    }
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
