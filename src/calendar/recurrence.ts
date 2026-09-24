import { z } from 'zod';
import { RECURRENCE_KINDS, type RecurrenceKind } from '../database/schema';
import { dayOfMonth, isoWeekday, localDate } from './local-date';

/**
 * `Recurrence` in `docs/api-plan.md` §1, as it travels on the wire. Blocks use
 * it now; general-list tasks that repeat on their own will use the same shape.
 *
 * On the way out `weekdays` and `monthDays` are always explicit: the one the
 * kind uses is never empty, and the other is `[]`.
 */
export interface Recurrence {
  kind: RecurrenceKind;
  /** 1 = Monday … 7 = Sunday. */
  weekdays: number[];
  /** 1..31. A day past a short month's end falls on its last day (REC-02). */
  monthDays: number[];
  /** Null means the repeat never ends (REC-03). */
  until: string | null;
}

const dayList = (max: number) =>
  z
    .array(z.number().int().min(1).max(max))
    .max(max)
    // Duplicates are harmless, so they are dropped rather than refused.
    .transform((days) => [...new Set(days)].sort((a, b) => a - b));

/**
 * A recurrence as a client sends it. `weekdays` is accepted only with
 * `weekly`, `monthDays` only with `monthly`, and `until` only with a kind that
 * repeats. An empty or missing day list means the anchor's own day, which
 * `resolveRecurrence` fills in once the anchor is known.
 */
export const recurrenceInput = z
  .strictObject({
    kind: z.enum(RECURRENCE_KINDS),
    weekdays: dayList(7).optional(),
    monthDays: dayList(31).optional(),
    until: localDate.nullable().optional(),
  })
  .superRefine((r, ctx) => {
    if (r.weekdays !== undefined && r.kind !== 'weekly') {
      ctx.addIssue({
        code: 'custom',
        path: ['weekdays'],
        message: 'Only a weekly recurrence has weekdays.',
      });
    }
    if (r.monthDays !== undefined && r.kind !== 'monthly') {
      ctx.addIssue({
        code: 'custom',
        path: ['monthDays'],
        message: 'Only a monthly recurrence has monthDays.',
      });
    }
    if (r.until != null && r.kind === 'none') {
      ctx.addIssue({
        code: 'custom',
        path: ['until'],
        message: 'A recurrence that does not repeat has no until.',
      });
    }
  });

export type RecurrenceInput = z.output<typeof recurrenceInput>;

export const NO_RECURRENCE: Recurrence = {
  kind: 'none',
  weekdays: [],
  monthDays: [],
  until: null,
};

/**
 * The recurrence to store for a series anchored on `anchor`. An empty day list
 * becomes the anchor's weekday or day of the month, as the app reads it, so
 * nothing downstream needs the anchor to interpret a recurrence.
 */
export function resolveRecurrence(
  input: RecurrenceInput | undefined,
  anchor: string,
): Recurrence {
  if (input === undefined || input.kind === 'none') return NO_RECURRENCE;

  const weekdays = input.weekdays ?? [];
  const monthDays = input.monthDays ?? [];

  return {
    kind: input.kind,
    weekdays:
      input.kind === 'weekly'
        ? weekdays.length > 0
          ? weekdays
          : [isoWeekday(anchor)]
        : [],
    monthDays:
      input.kind === 'monthly'
        ? monthDays.length > 0
          ? monthDays
          : [dayOfMonth(anchor)]
        : [],
    until: input.until ?? null,
  };
}
