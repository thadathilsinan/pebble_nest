import { Inject, Injectable } from '@nestjs/common';
import type { Caller } from '../auth/caller';
import { chosenTraceFor, tracesByName } from '../block-names/block-name';
import { BlockOccurrencesRepository } from '../block-occurrences/block-occurrences.repository';
import { BlockNamesRepository } from '../block-names/block-names.repository';
import { addDays } from '../calendar/local-date';
import { occursOn } from '../calendar/recurrence';
import {
  recurrenceOf,
  toBlockOccurrence,
  type BlockOccurrence,
} from '../blocks/blocks.mapper';
import { BlocksRepository } from '../blocks/blocks.repository';
import { DB, type Db } from '../core/database/database.module';
import type { BlockSeriesRow, ChosenTrace } from '../core/database/schema';
import { compareTasks, toTask, type Task } from '../tasks/tasks.mapper';
import { TasksRepository } from '../tasks/tasks.repository';

/** `Day` in `docs/api-plan.md` §3. */
export interface Day {
  date: string;
  /** Yesterday's midnight-crossing tails first, then by start time. */
  blocks: BlockOccurrence[];
  /** The day's tasks in no block, in the order the app shows them. */
  generalList: Task[];
}

@Injectable()
export class DaysService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly blocks: BlocksRepository,
    private readonly tasks: TasksRepository,
    private readonly names: BlockNamesRepository,
    private readonly occurrences: BlockOccurrencesRepository,
  ) {}

  /**
   * Every day from `from` to `to`, both included, from one read each of the
   * caller's series, their tasks, their chosen traces and their skipped
   * occurrences. It does not read the session (decision 16).
   */
  async list(caller: Caller, from: string, to: string): Promise<Day[]> {
    // The day before `from`, for the tails of blocks that began then and the
    // tasks those tails hold.
    const since = addDays(from, -1);
    const [rows, taskRows, traceRows, skippedRows] = await Promise.all([
      this.blocks.findActiveBetween(this.db, caller.userId, since, to),
      this.tasks.findBetween(this.db, caller.userId, since, to),
      this.names.findTraces(this.db, caller.userId),
      this.occurrences.findSkippedBetween(this.db, caller.userId, since, to),
    ]);
    const tasks = groupTasks(taskRows.map(toTask));
    const traces = tracesByName(traceRows);
    const skipped = new Set(
      skippedRows.map((row) => slot(row.blockSeriesId, row.date)),
    );

    const days: Day[] = [];
    for (let date = from; date <= to; date = addDays(date, 1)) {
      days.push({
        date,
        blocks: blocksOn(rows, date, tasks, traces, skipped),
        generalList: tasks.get(slot(null, date)) ?? [],
      });
    }
    return days;
  }
}

/**
 * Where a task sits: a block occurrence, named by its series and the day it
 * starts, or a date's general list.
 */
function slot(blockSeriesId: string | null, date: string): string {
  return `${blockSeriesId ?? 'general'}/${date}`;
}

/** Tasks by `slot`, each list in the order the app shows it. */
function groupTasks(tasks: Task[]): Map<string, Task[]> {
  const out = new Map<string, Task[]>();
  for (const task of tasks) {
    const key = slot(task.blockSeriesId, task.date);
    const list = out.get(key);
    if (list === undefined) out.set(key, [task]);
    else list.push(task);
  }
  for (const list of out.values()) list.sort(compareTasks);
  return out;
}

/**
 * The occurrences that start on `date`, plus the tails of those that started
 * the day before and cross midnight (BLK-04). A block ending exactly at
 * midnight has no tail: nothing of it falls on the next day. `skipped` holds
 * the `slot`s of skipped occurrences, and a tail is skipped with its
 * occurrence.
 */
function blocksOn(
  rows: BlockSeriesRow[],
  date: string,
  tasks: Map<string, Task[]>,
  traces: ReadonlyMap<string, ChosenTrace>,
  skipped: ReadonlySet<string>,
): BlockOccurrence[] {
  const yesterday = addDays(date, -1);
  const out: BlockOccurrence[] = [];

  for (const row of rows) {
    const recurrence = recurrenceOf(row);
    const trace = chosenTraceFor(traces, row.name);
    if (
      crossesMidnight(row) &&
      row.endMin > 0 &&
      occursOn(recurrence, row.anchorDate, yesterday)
    ) {
      // A tail holds the tasks of the occurrence it ends, as the app shows.
      const key = slot(row.id, yesterday);
      out.push(
        toBlockOccurrence(row, yesterday, trace, {
          continuedFromPreviousDay: true,
          tasks: tasks.get(key) ?? [],
          skipped: skipped.has(key),
        }),
      );
    }
    if (occursOn(recurrence, row.anchorDate, date)) {
      const key = slot(row.id, date);
      out.push(
        toBlockOccurrence(row, date, trace, {
          tasks: tasks.get(key) ?? [],
          skipped: skipped.has(key),
        }),
      );
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
