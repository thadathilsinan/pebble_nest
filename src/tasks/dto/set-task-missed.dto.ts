import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * `PATCH /tasks/{id}/missed`. No `version`, as `/done` has none: `missed` is
 * an absolute value, so the last write wins and a retry is harmless.
 */
export class SetTaskMissedBody extends createZodDto(
  z.strictObject({ missed: z.boolean() }),
) {}
