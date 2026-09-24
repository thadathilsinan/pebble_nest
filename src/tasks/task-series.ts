import { addDays, daysBetween } from '../calendar/local-date';
import {
  firstOccurrenceFrom,
  occursOn,
  type Recurrence,
} from '../calendar/recurrence';
import type { TaskSeriesRow } from '../core/database/schema';

/**
 * Where a series' occurrences land besides its own anchor: by its own
 * recurrence, or, repeating with a block, on the days that block occurs.
 */
export type SeriesDays = Pick<
  TaskSeriesRow,
  | 'anchorDate'
  | 'endedOn'
  | 'blockSeriesId'
  | 'recurrenceKind'
  | 'weekdays'
  | 'monthDays'
  | 'until'
>;

/**
 * Whether the block with this id has a live occurrence starting on `date`:
 * one its rule lands on and that has not been deleted. A skipped occurrence
 * still counts, as in the app, whose `BlockSeries.occursOn` ignores skips.
 */
export type BlockOccursOn = (blockSeriesId: string, date: string) => boolean;

/** A general-list series' own recurrence; null for one in a block. */
export function ownRecurrenceOf(series: SeriesDays): Recurrence | null {
  if (series.blockSeriesId !== null) return null;
  return {
    kind: series.recurrenceKind,
    weekdays: series.weekdays,
    monthDays: series.monthDays,
    until: series.until,
  };
}

/**
 * Whether the series has an occurrence on `date`. Its anchor is always one,
 * even off its rule, as the app's first occurrence is the task it was
 * started from. Nothing lands before the anchor or after `ended_on`.
 */
export function landsOn(
  series: SeriesDays,
  date: string,
  blockOccursOn: BlockOccursOn,
): boolean {
  if (date < series.anchorDate) return false;
  if (series.endedOn !== null && date > series.endedOn) return false;
  if (date === series.anchorDate) return true;

  const own = ownRecurrenceOf(series);
  if (own !== null) return occursOn(own, series.anchorDate, date);
  return blockOccursOn(series.blockSeriesId!, date);
}

/**
 * How far past a date the next occurrence is looked for, as the app's
 * `_nextTaskSeriesDay` looks. Past that, the next one is too far away to
 * matter to REC-06, which only asks whether it is within a day.
 */
const SEARCH_DAYS = 400;

/**
 * The series' first occurrence after `date`, or null when there is none
 * within `SEARCH_DAYS`.
 */
export function nextOccurrenceAfter(
  series: SeriesDays,
  date: string,
  blockOccursOn: BlockOccursOn,
): string | null {
  const own = ownRecurrenceOf(series);
  if (own !== null) {
    const next = firstOccurrenceFrom(own, series.anchorDate, addDays(date, 1));
    if (next === null) return null;
    return series.endedOn !== null && next > series.endedOn ? null : next;
  }

  for (let i = 1; i <= SEARCH_DAYS; i++) {
    const day = addDays(date, i);
    if (series.endedOn !== null && day > series.endedOn) return null;
    if (landsOn(series, day, blockOccursOn)) return day;
  }
  return null;
}

/** Where `settle` puts a task. */
export interface Settled {
  /** The day it now sits on: today, or the day it was missed on. */
  date: string;
  /** The carries it made, one per day it left. */
  carryDays: number;
  missed: boolean;
}

/**
 * Where an open task left on a closed day ends up once the days since have
 * closed over it (TSK-06/07, REC-06).
 *
 * `date` is the closed day it sits on, `today` the first day not closed, and
 * `next` its series' next occurrence after `date`, or null for a one-off or
 * a series with none coming. Each closed day it sits through records it
 * incomplete and carries it to the next day's general list, until the day
 * before its series' next occurrence: that day records it missed and it
 * stays there. So a task whose next occurrence is the following day, as a
 * daily one's always is, is missed on its own day and never carries.
 */
export function settle(
  date: string,
  today: string,
  next: string | null,
): Settled {
  if (next !== null && next <= today) {
    const missedOn = addDays(next, -1);
    return {
      date: missedOn,
      carryDays: daysBetween(date, missedOn),
      missed: true,
    };
  }
  return { date: today, carryDays: daysBetween(date, today), missed: false };
}
