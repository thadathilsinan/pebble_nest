import { createZodDto } from 'nestjs-zod';
import { localDateRange } from '../../calendar/local-date';

/** The most days one `GET /days` returns, `from` and `to` included. */
export const MAX_DAYS_PER_REQUEST = 14;

/**
 * `GET /days?from=&to=`: swipe prefetch and the Now screen's today and
 * tomorrow. Both ends are included.
 */
export class ListDaysQuery extends createZodDto(
  localDateRange(MAX_DAYS_PER_REQUEST),
) {}
