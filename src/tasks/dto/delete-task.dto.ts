import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * `DELETE /tasks/{id}?scope=`. `series` ends a repeating task's series from
 * today on; a one-off has no series, so either scope deletes just the task.
 */
export class DeleteTaskQuery extends createZodDto(
  z.object({
    scope: z.enum(['onlyThis', 'series']).default('onlyThis'),
  }),
) {}
