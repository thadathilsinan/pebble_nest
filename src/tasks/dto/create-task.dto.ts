import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { localDate } from '../../calendar/local-date';
import { recurrenceInput } from '../../calendar/recurrence';
import { localDateTime } from './local-date-time';

/**
 * `POST /tasks`. Which repeat fields go with which placement is checked by the
 * service, since it has its own code (`REPEAT_NOT_ALLOWED`) and one case needs
 * the block's recurrence.
 */
export class CreateTaskBody extends createZodDto(
  z
    .strictObject({
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
    })
    // A repeating task's first occurrence is `date`, so its repeat cannot
    // end before it.
    .refine(
      ({ date, recurrence }) =>
        recurrence?.until == null || recurrence.until >= date,
      {
        path: ['recurrence', 'until'],
        message: 'The repeat cannot end before the task’s date.',
      },
    ),
) {}
