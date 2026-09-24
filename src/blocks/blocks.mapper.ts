import type { Recurrence } from '../calendar/recurrence';
import type { BlockSeriesRow, ChosenTrace } from '../core/database/schema';
import type { Task } from '../tasks/tasks.mapper';

/** `BlockOccurrence` in `docs/api-plan.md` §1: one series on one date. */
export interface BlockOccurrence {
  seriesId: string;
  seriesVersion: number;
  /** The day the occurrence starts. */
  date: string;
  name: string;
  startMin: number;
  endMin: number;
  alert: boolean;
  skipped: boolean;
  recurrence: Recurrence;
  /** The user's chosen fill pattern for this name; null is the name's default. */
  trace: ChosenTrace | null;
  /** The tail of yesterday's midnight-crossing block. */
  continuedFromPreviousDay: boolean;
  /** In the order the app shows them (`compareTasks`). */
  tasks: Task[];
  openCount: number;
  totalCount: number;
}

/** The series' recurrence, in its wire shape. */
export function recurrenceOf(row: BlockSeriesRow): Recurrence {
  return {
    kind: row.recurrenceKind,
    weekdays: row.weekdays,
    monthDays: row.monthDays,
    until: row.until,
  };
}

/**
 * The occurrence of `row` that starts on `date`, holding `tasks`, which the
 * caller has already put in order. With no exceptions table yet, every
 * occurrence is the series itself: not skipped, not edited.
 *
 * `continuedFromPreviousDay` marks the copy of yesterday's midnight-crossing
 * occurrence that a day's timeline shows as its tail (BLK-04). `date` is still
 * the day it starts.
 *
 * `trace` is the one chosen for the series' name, or null for its default.
 */
export function toBlockOccurrence(
  row: BlockSeriesRow,
  date: string,
  trace: ChosenTrace | null,
  continuedFromPreviousDay = false,
  tasks: Task[] = [],
): BlockOccurrence {
  return {
    seriesId: row.id,
    seriesVersion: row.version,
    date,
    name: row.name,
    startMin: row.startMin,
    endMin: row.endMin,
    alert: row.alert,
    skipped: false,
    recurrence: recurrenceOf(row),
    trace,
    continuedFromPreviousDay,
    tasks,
    openCount: tasks.filter((task) => !task.done).length,
    totalCount: tasks.length,
  };
}
