import { localDateTime } from '../calendar/local-date';
import type { Recurrence } from '../calendar/recurrence';
import type { TaskRow, TaskSeriesRow } from '../core/database/schema';
import { ownRecurrenceOf } from './task-series';

/** `Task.repeat`: how the task's series repeats. */
export interface TaskRepeat {
  mode: 'withBlock' | 'own';
  /** Set only when `mode` is `own`. */
  recurrence: Recurrence | null;
}

/** `Task` in `docs/api-plan.md` §1. */
export interface Task {
  id: string;
  version: number;
  title: string;
  notes: string;
  date: string;
  /** Null is the date's general list. */
  blockSeriesId: string | null;
  /** Local wall-clock time, `YYYY-MM-DDTHH:mm`, no offset. */
  reminderAt: string | null;
  done: boolean;
  doneAt: string | null;
  carryCount: number;
  missed: boolean;
  /** Null is a one-off. */
  repeat: TaskRepeat | null;
}

/** A task, and the series it is an occurrence of, if any. */
export interface TaskWithSeries {
  task: TaskRow;
  series: TaskSeriesRow | null;
}

/**
 * `series` is the row `task.taskSeriesId` names. A task carried or missed
 * is still an occurrence of its series; one split off by a move is not.
 */
export function toTask({ task: row, series }: TaskWithSeries): Task {
  return {
    id: row.id,
    version: row.version,
    title: row.title,
    notes: row.notes,
    date: row.date,
    blockSeriesId: row.blockSeriesId,
    reminderAt:
      row.reminderDate === null || row.reminderMin === null
        ? null
        : localDateTime(row.reminderDate, row.reminderMin),
    done: row.done,
    doneAt: row.doneAt?.toISOString() ?? null,
    carryCount: row.carryCount,
    missed: row.missed,
    repeat:
      series === null
        ? null
        : series.blockSeriesId === null
          ? { mode: 'own', recurrence: ownRecurrenceOf(series) }
          : { mode: 'withBlock', recurrence: null },
  };
}

/**
 * The order the app shows a list of tasks in: open before done, then the most
 * carried first, so a task put off again and again sits where it cannot be
 * missed, then title A–Z. The id settles ties so the order is stable.
 */
export function compareTasks(a: Task, b: Task): number {
  return (
    Number(a.done) - Number(b.done) ||
    b.carryCount - a.carryCount ||
    // Lower-cased and compared by code unit, as the app's `_taskOrder` does,
    // rather than by locale, so both sides agree on every title.
    compare(a.title.toLowerCase(), b.title.toLowerCase()) ||
    compare(a.id, b.id)
  );
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
