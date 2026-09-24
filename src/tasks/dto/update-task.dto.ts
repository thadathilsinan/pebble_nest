import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { recurrenceInput } from '../../calendar/recurrence';
import { localDateTime } from './local-date-time';

/**
 * `PATCH /tasks/{id}`. The fields follow `POST /tasks`; an absent one is left
 * as it is, and a null `reminderAt` clears the reminder. The task slip sends
 * the repeat fields on every save, so they are accepted here and checked by
 * the service, as on create. Where the task sits is changed by `/move`, not
 * here.
 */
export class UpdateTaskBody extends createZodDto(
  z.strictObject({
    version: z.number().int().nonnegative(),
    // TSK-01: required, up to 200 characters.
    title: z.string().trim().min(1).max(200).optional(),
    notes: z.string().max(10_000).optional(),
    reminderAt: localDateTime.nullable().optional(),
    repeatWithBlock: z.boolean().optional(),
    recurrence: recurrenceInput.optional(),
  }),
) {}
