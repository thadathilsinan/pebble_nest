import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { TIME_FORMATS, WEEK_STARTS } from '../../database/schema';

/**
 * Whether the runtime's time-zone database knows `zone`. A raw UTC offset such
 * as `+05:30` is refused even though `Intl` accepts one: it doesn't follow
 * daylight saving, so carry-over at local midnight would drift. The device
 * always has a real IANA name to send.
 *
 * The zone is stored as sent. `resolvedOptions().timeZone` is not used to
 * normalise it, because ICU rewrites current names to legacy ones
 * (`Asia/Kolkata` becomes `Asia/Calcutta`).
 */
function isIanaTimeZone(zone: string): boolean {
  if (/^[+-]/.test(zone)) return false;

  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

const profilePatch = z.strictObject({
  version: z.number().int().nonnegative().optional(),
  // Optional and never asked for (decision 10). A blank name clears it, like
  // null does: the client shows the email instead.
  name: z
    .string()
    .trim()
    .max(80)
    .transform((name) => (name === '' ? null : name))
    .nullable()
    .optional(),
  weekStart: z.enum(WEEK_STARTS).optional(),
  timeFormat: z.enum(TIME_FORMATS).optional(),
  timeZone: z
    .string()
    .max(64)
    .refine(isIanaTimeZone, 'Not a known IANA time zone.')
    .optional(),
});

/**
 * `PATCH /me`. `version` is required unless `timeZone` is the only field sent:
 * the client reports its zone silently on every app open, and that report is
 * last-write-wins rather than a versioned edit (decision 17 in
 * `docs/api-plan.md`).
 */
export class UpdateProfileBody extends createZodDto(
  profilePatch.superRefine((body, ctx) => {
    if (body.version === undefined && !isTimeZoneOnly(body)) {
      ctx.addIssue({
        code: 'custom',
        path: ['version'],
        message: 'Required unless timeZone is the only field sent.',
      });
    }
  }),
) {}

/** Whether a patch holds a time zone and nothing else, `version` aside. */
export function isTimeZoneOnly(
  body: z.output<typeof profilePatch>,
): body is { timeZone: string; version?: number } {
  return (
    body.timeZone !== undefined &&
    Object.entries(body).every(
      ([key, value]) =>
        key === 'version' || key === 'timeZone' || value === undefined,
    )
  );
}
