import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** `/tasks/{id}/…`. */
export class TaskIdParams extends createZodDto(z.object({ id: z.uuid() })) {}

/**
 * `PATCH /tasks/{id}/done`. No `version`: `done` is an absolute value, so the
 * last write wins and a retry is harmless.
 */
export class SetTaskDoneBody extends createZodDto(
  z.strictObject({ done: z.boolean() }),
) {}
