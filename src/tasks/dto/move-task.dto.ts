import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { localDate } from '../../calendar/local-date';

/**
 * `POST /tasks/{id}/move` (TSK-03): where the task goes, both fields
 * required. A null `blockSeriesId` is the date's general list. No `version`:
 * a place is an absolute value, so the last write wins and a retry is
 * harmless, as with `/done`.
 */
export class MoveTaskBody extends createZodDto(
  z.strictObject({
    date: localDate,
    blockSeriesId: z.uuid().nullable(),
  }),
) {}
