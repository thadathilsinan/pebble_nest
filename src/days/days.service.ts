import { Inject, Injectable } from '@nestjs/common';
import type { Caller } from '../auth/caller';
import { tracesByName } from '../block-names/block-name';
import { BlockOccurrencesRepository } from '../block-occurrences/block-occurrences.repository';
import { BlockNamesRepository } from '../block-names/block-names.repository';
import { addDays } from '../calendar/local-date';
import { occursOn } from '../calendar/recurrence';
import {
  crossesMidnight,
  recurrenceOf,
  shapeOf,
  toBlockOccurrence,
  type BlockOccurrence,
} from '../blocks/blocks.mapper';
import { BlocksRepository } from '../blocks/blocks.repository';
import { DB, type Db } from '../core/database/database.module';
import type {
  BlockOccurrenceExceptionRow,
  BlockSeriesRow,
  ChosenTrace,
} from '../core/database/schema';
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
   * caller's series, their tasks, their chosen traces and their occurrence
   * exceptions. It does not read the session (decision 16).
   */
  async list(caller: Caller, from: string, to: string): Promise<Day[]> {
    // The day before `from`, for the tails of blocks that began then and the
    // tasks those tails hold.
    const since = addDays(from, -1);
    const [rows, taskRows, traceRows, exceptionRows] = await Promise.all([
      this.blocks.findActiveBetween(this.db, caller.userId, since, to),
      this.tasks.findBetween(this.db, caller.userId, since, to),
      this.names.findTraces(this.db, caller.userId),
      this.occurrences.findBetween(this.db, caller.userId, since, to),
    ]);
    const tasks = groupTasks(taskRows.map(toTask));
    const traces = tracesByName(traceRows);
    const exceptions = new Map(
      exceptionRows.map((row) => [slot(row.blockSeriesId, row.date), row]),
    );

    const days: Day[] = [];
    for (let date = from; date <= to; date = addDays(date, 1)) {
      days.push({
        date,
        blocks: blocksOn(rows, date, tasks, traces, exceptions),
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
 * midnight has no tail: nothing of it falls on the next day. A tail is
 * skipped and overridden with its occurrence, so whether there is one
 * follows the occurrence's own times, and a deleted occurrence is left out
 * along with its tail.
 */
function blocksOn(
  rows: BlockSeriesRow[],
  date: string,
  tasks: Map<string, Task[]>,
  traces: ReadonlyMap<string, ChosenTrace>,
  exceptions: ReadonlyMap<string, BlockOccurrenceExceptionRow>,
): BlockOccurrence[] {
  const yesterday = addDays(date, -1);
  const out: BlockOccurrence[] = [];

  for (const row of rows) {
    const recurrence = recurrenceOf(row);
    const tail = slot(row.id, yesterday);
    const tailException = exceptions.get(tail) ?? null;
    const tailShape = shapeOf(row, tailException);
    if (
      crossesMidnight(tailShape) &&
      tailShape.endMin > 0 &&
      occursOn(recurrence, row.anchorDate, yesterday) &&
      !tailException?.deleted
    ) {
      // A tail holds the tasks of the occurrence it ends, as the app shows.
      out.push(
        toBlockOccurrence(row, yesterday, traces, {
          continuedFromPreviousDay: true,
          tasks: tasks.get(tail) ?? [],
          exception: tailException,
        }),
      );
    }
    const key = slot(row.id, date);
    const exception = exceptions.get(key) ?? null;
    if (occursOn(recurrence, row.anchorDate, date) && !exception?.deleted) {
      out.push(
        toBlockOccurrence(row, date, traces, {
          tasks: tasks.get(key) ?? [],
          exception,
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

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
