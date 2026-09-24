import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { localDate } from '../../calendar/local-date';
import { recurrenceInput } from '../../calendar/recurrence';

/** Minutes from local midnight. */
export const minuteOfDay = z.number().int().min(0).max(1439);

/** Trimmed, 1–60 characters. */
export const blockName = z.string().trim().min(1).max(60);

/**
 * `POST /blocks`. The 5-minute minimum (BLK-05) is not checked here: it has
 * its own code, `BLOCK_TOO_SHORT`, which the service throws. There is no
 * maximum to check, since `endMin = startMin` is already a full 24 hours.
 */
export class CreateBlockBody extends createZodDto(
  z
    .strictObject({
      name: blockName,
      date: localDate,
      startMin: minuteOfDay,
      // `endMin <= startMin` crosses midnight (BLK-04).
      endMin: minuteOfDay,
      recurrence: recurrenceInput.optional(),
      alert: z.boolean(),
      // schema-conventions §9: reused by the client when it retries this
      // create, scoped to the signed-in user.
      idempotencyKey: z.uuid().optional(),
    })
    .superRefine((body, ctx) => {
      const until = body.recurrence?.until;
      if (until != null && until < body.date) {
        ctx.addIssue({
          code: 'custom',
          path: ['recurrence', 'until'],
          message: 'The repeat cannot end before the block starts.',
        });
      }
    }),
) {}
