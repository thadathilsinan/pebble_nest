import {
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { occursOn } from '../calendar/recurrence';
import type {
  BlockOccurrenceExceptionRow,
  BlockSeriesRow,
} from '../core/database/schema';
import type { ErrorCode } from '../core/http/error-code';
import { recurrenceOf } from './blocks.mapper';

/** BLK-05's lower bound. */
const MIN_BLOCK_MINUTES = 5;

/**
 * A series, and its occurrence's exception row on some date: whether it has
 * been deleted, and what it skips or overrides.
 */
export interface FoundOccurrence {
  series: BlockSeriesRow;
  exception: BlockOccurrenceExceptionRow | null;
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

/** BLK-05: a block lasts at least 5 minutes, counting a midnight crossing. */
export function assertLongEnough({
  startMin,
  endMin,
}: {
  startMin: number;
  endMin: number;
}): void {
  if (lengthInMinutes(startMin, endMin) < MIN_BLOCK_MINUTES) {
    throw new UnprocessableEntityException({
      code: 'BLOCK_TOO_SHORT' satisfies ErrorCode,
      message: `A block lasts at least ${MIN_BLOCK_MINUTES} minutes.`,
    });
  }
}

/** A repeat whose `until` comes before the first day its rule lands on. */
export function noOccurrence(): UnprocessableEntityException {
  return new UnprocessableEntityException({
    code: 'BLOCK_NO_OCCURRENCE' satisfies ErrorCode,
    message: 'The repeat ends before the block falls on any day.',
  });
}

/**
 * A block's length, counting a midnight crossing (BLK-04). `end = start` is a
 * full day rather than nothing.
 */
function lengthInMinutes(startMin: number, endMin: number): number {
  return endMin > startMin ? endMin - startMin : 1440 - startMin + endMin;
}
