import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { minuteOfDay, blockName } from '../../blocks/dto/create-block.dto';
import { localDate } from '../../calendar/local-date';
import { recurrenceInput } from '../../calendar/recurrence';

const editScope = z.enum(['onlyThis', 'thisAndFuture']);

export type EditScope = z.output<typeof editScope>;

/**
 * `PATCH /blocks/{seriesId}/occurrences/{date}`. The fields follow
 * `POST /blocks`; an absent one is left as it is. `scope` is ignored for a
 * block that doesn't repeat. Which fields a scope accepts depends on whether
 * the series repeats, so the service checks that, after the version.
 */
export class UpdateOccurrenceBody extends createZodDto(
  z.strictObject({
    version: z.number().int().nonnegative(),
    scope: editScope.default('onlyThis'),
    name: blockName.optional(),
    startMin: minuteOfDay.optional(),
    // `endMin <= startMin` crosses midnight (BLK-04).
    endMin: minuteOfDay.optional(),
    // BLK-09: the occurrence's tasks go with it.
    newDate: localDate.optional(),
    recurrence: recurrenceInput.optional(),
    alert: z.boolean().optional(),
  }),
) {}
