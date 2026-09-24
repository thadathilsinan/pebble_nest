import {
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { occursOn } from '../calendar/recurrence';
import type { BlockSeriesRow } from '../core/database/schema';
import type { ErrorCode } from '../core/http/error-code';
import { recurrenceOf } from './blocks.mapper';

/**
 * An occurrence that exists: one of the caller's series, on a day it falls
 * on. `date` is the day the occurrence starts, so a midnight-crossing block's
 * occurrence is named by the day it began.
 */
export function assertOccursOn(
  series: BlockSeriesRow | null,
  date: string,
): asserts series is BlockSeriesRow {
  if (series === null) {
    throw new NotFoundException({
      code: 'NOT_FOUND' satisfies ErrorCode,
      message: 'No such block.',
    });
  }
  if (!occursOn(recurrenceOf(series), series.anchorDate, date)) {
    throw new UnprocessableEntityException({
      code: 'BLOCK_NOT_ON_DATE' satisfies ErrorCode,
      message: 'The block does not fall on that date.',
    });
  }
}
