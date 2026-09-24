import type { TaskRow } from '../core/database/schema';

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
  // Repeating tasks come with the task series slice. Until then every task is
  // truthfully a one-off.
  repeat: null;
}

export function toTask(row: TaskRow): Task {
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
        : `${row.reminderDate}T${clock(row.reminderMin)}`,
    done: row.done,
    doneAt: row.doneAt?.toISOString() ?? null,
    carryCount: row.carryCount,
    missed: row.missed,
    repeat: null,
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

/** Minutes from midnight as `HH:mm`. */
function clock(minutes: number): string {
  const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
  const mm = String(minutes % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}
