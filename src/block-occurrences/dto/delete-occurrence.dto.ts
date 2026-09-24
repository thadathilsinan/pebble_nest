import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const deleteScope = z.enum(['onlyThis', 'series']);

export type DeleteScope = z.output<typeof deleteScope>;

/**
 * `DELETE /blocks/{seriesId}/occurrences/{date}?scope=`. `series` deletes the
 * series from today on, and the occurrence named; a block that doesn't repeat
 * is deleted whatever the scope.
 */
export class DeleteOccurrenceQuery extends createZodDto(
  z.object({ scope: deleteScope.default('onlyThis') }),
) {}
