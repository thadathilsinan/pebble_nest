import { createZodDto } from 'nestjs-zod';
import { localDateRange } from '../../calendar/local-date';

/**
 * `GET /review?from=&to=`. Both ends are included, and the range has no cap:
 * the service lays out only the days that can hold a block.
 */
export class ReviewQuery extends createZodDto(localDateRange()) {}
