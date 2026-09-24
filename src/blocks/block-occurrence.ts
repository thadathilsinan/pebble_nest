import {
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { occursOn } from '../calendar/recurrence';
import type { BlockSeriesRow } from '../core/database/schema';
import type { ErrorCode } from '../core/http/error-code';
import { recurrenceOf } from './blocks.mapper';

/** A series, and whether its occurrence on some date has been deleted. */
export interface FoundOccurrence {
  series: BlockSeriesRow;
  deleted: boolean;
}

/**
 * An occurrence that exists: one of the caller's series, on a day it falls
 * on, not deleted. `date` is the day the occurrence starts, so a
 * midnight-crossing block's occurrence is named by the day it began.
 *
 * A deleted occurrence is a 404, as a deleted task is, while a day the rule
 * never lands on is a 422 (decision 29).
 */
export function assertOccursOn(
  found: FoundOccurrence | null,
  date: string,
): asserts found is FoundOccurrence {
  if (found === null) throw blockNotFound();
  const { series } = found;
  if (!occursOn(recurrenceOf(series), series.anchorDate, date)) {
    throw new UnprocessableEntityException({
      code: 'BLOCK_NOT_ON_DATE' satisfies ErrorCode,
      message: 'The block does not fall on that date.',
    });
  }
  if (found.deleted) throw blockNotFound();
}

function blockNotFound(): NotFoundException {
  return new NotFoundException({
    code: 'NOT_FOUND' satisfies ErrorCode,
    message: 'No such block.',
  });
}
