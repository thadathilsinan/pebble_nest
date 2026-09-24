import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { localDate } from '../../calendar/local-date';
import { recurrenceInput } from '../../calendar/recurrence';

/**
 * A local wall-clock reading with no offset, `YYYY-MM-DDTHH:mm` (decision 6),
 * parsed into the date and minutes from its midnight that `tasks` stores.
 */
const LOCAL_DATE_TIME = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d)$/;

const localDateTime = z.string().transform((value, ctx) => {
  const match = LOCAL_DATE_TIME.exec(value);
  if (match === null || !localDate.safeParse(match[1]).success) {
    ctx.addIssue({
      code: 'custom',
      message: 'Expected a real YYYY-MM-DDTHH:mm in local time, no offset.',
    });
    return z.NEVER;
  }
  // Every group took part in the match, so the defaults never apply.
  const [, date = '', hours = '', minutes = ''] = match;
  return { date, min: Number(hours) * 60 + Number(minutes) };
});

/**
 * `POST /tasks`. Which repeat fields go with which placement is checked by the
 * service, since it has its own code (`REPEAT_NOT_ALLOWED`) and one case needs
 * the block's recurrence.
 */
export class CreateTaskBody extends createZodDto(
  z.strictObject({
    // TSK-01: required, up to 200 characters.
    title: z.string().trim().min(1).max(200),
    date: localDate,
    // Null or absent is the date's general list (TSK-02).
    blockSeriesId: z.uuid().nullable().optional(),
    notes: z.string().max(10_000).optional(),
    reminderAt: localDateTime.nullable().optional(),
    repeatWithBlock: z.boolean().optional(),
    recurrence: recurrenceInput.optional(),
    // schema-conventions §9: reused by the client when it retries this
    // create, scoped to the signed-in user.
    idempotencyKey: z.uuid().optional(),
  }),
) {}
