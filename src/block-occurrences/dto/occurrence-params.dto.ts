import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { localDate } from '../../calendar/local-date';

/**
 * `/blocks/{seriesId}/occurrences/{date}/…`: one series on one date, the day
 * the occurrence starts.
 */
export class OccurrenceParams extends createZodDto(
  z.object({ seriesId: z.uuid(), date: localDate }),
) {}
