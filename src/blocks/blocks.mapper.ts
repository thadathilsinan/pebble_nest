import { chosenTraceFor } from '../block-names/block-name';
import type { Recurrence } from '../calendar/recurrence';
import type {
  BlockOccurrenceExceptionRow,
  BlockSeriesRow,
  ChosenTrace,
} from '../core/database/schema';
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

/** What editing only one occurrence can change about it. */
export interface OccurrenceShape {
  name: string;
  startMin: number;
  endMin: number;
  alert: boolean;
}

/** An occurrence's exception row, as far as its shape and status go. */
export type OccurrenceException = Pick<
  BlockOccurrenceExceptionRow,
  'skipped' | 'name' | 'startMin' | 'endMin' | 'alert'
>;

/**
 * The name, times and alert of `row`'s occurrence with `exception`: the
 * series' own, except where the occurrence overrides them.
 */
export function shapeOf(
  row: BlockSeriesRow,
  exception: OccurrenceException | null = null,
): OccurrenceShape {
  return {
    name: exception?.name ?? row.name,
    startMin: exception?.startMin ?? row.startMin,
    endMin: exception?.endMin ?? row.endMin,
    alert: exception?.alert ?? row.alert,
  };
}

/** `end_min <= start_min`, as the schema reads it; equal is a full day. */
export function crossesMidnight({
  startMin,
  endMin,
}: OccurrenceShape): boolean {
  return endMin <= startMin;
}

/** What an occurrence has beyond its series, all absent by default. */
export interface OccurrenceExtras {
  /**
   * Marks the copy of yesterday's midnight-crossing occurrence that a day's
   * timeline shows as its tail (BLK-04). `date` is still the day it starts.
   */
  continuedFromPreviousDay?: boolean;
  /** Already in the order the app shows them. */
  tasks?: Task[];
  /** Its exception row: skipped (BLK-07), and what only it overrides. */
  exception?: OccurrenceException | null;
}

/**
 * The occurrence of `row` that starts on `date`: the series, with whatever
 * its exception row overrides or marks.
 *
 * `trace` is the one chosen for the occurrence's name in `traces`, or null
 * for its default.
 */
export function toBlockOccurrence(
  row: BlockSeriesRow,
  date: string,
  traces: ReadonlyMap<string, ChosenTrace>,
  {
    continuedFromPreviousDay = false,
    tasks = [],
    exception = null,
  }: OccurrenceExtras = {},
): BlockOccurrence {
  const shape = shapeOf(row, exception);
  return {
    seriesId: row.id,
    seriesVersion: row.version,
    date,
    ...shape,
    skipped: exception?.skipped ?? false,
    recurrence: recurrenceOf(row),
    trace: chosenTraceFor(traces, shape.name),
    continuedFromPreviousDay,
    tasks,
    openCount: tasks.filter((task) => !task.done).length,
    totalCount: tasks.length,
  };
}
