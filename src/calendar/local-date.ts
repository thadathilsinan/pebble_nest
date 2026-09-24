import { z } from 'zod';

/**
 * A calendar date with no time zone, `YYYY-MM-DD` (decision 6: time is local
 * everywhere). `z.iso.date()` rejects impossible dates such as `2026-02-30`.
 * The year is held to 1900–2999, well inside what a Postgres `date` accepts, so
 * a typo like `0026` is a 400 rather than a driver error.
 */
export const localDate = z.iso
  .date()
  .refine(
    (date) => date >= '1900-01-01' && date <= '2999-12-31',
    'The year must be between 1900 and 2999.',
  );

/** 1 = Monday … 7 = Sunday, as `Recurrence.weekdays` counts. */
export function isoWeekday(date: string): number {
  const weekday = asUtc(date).getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

/** 1..31. */
export function dayOfMonth(date: string): number {
  return asUtc(date).getUTCDate();
}

/** The number of days in `date`'s month: 28..31. */
export function daysInMonth(date: string): number {
  const d = asUtc(date);
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0),
  ).getUTCDate();
}

/** `date` moved by `days`, which may be negative. */
export function addDays(date: string, days: number): string {
  const d = asUtc(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Whole days from `from` to `to`: positive when `to` is later. */
export function daysBetween(from: string, to: string): number {
  return Math.round((asUtc(to).getTime() - asUtc(from).getTime()) / 86_400_000);
}

/**
 * Midnight UTC on `date`, for calendar arithmetic only. UTC because it has no
 * daylight-saving gaps, not because the date means anything in UTC.
 */
function asUtc(date: string): Date {
  return new Date(`${date}T00:00:00Z`);
}
