import { createZodDto } from 'nestjs-zod';
import { localDateRange } from '../../calendar/local-date';

/**
 * The most days one schedule covers, `from` and `to` included: the phone's
 * rolling window (NTF-04).
 */
export const MAX_SCHEDULE_DAYS = 7;

/** `GET /notifications/schedule?from=&to=`. Both ends are included. */
export class ScheduleQuery extends createZodDto(
  localDateRange(MAX_SCHEDULE_DAYS),
) {}
