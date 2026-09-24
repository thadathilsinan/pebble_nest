import {
  Inject,
  Injectable,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Caller } from '../auth/caller';
import { firstOccurrenceFrom, resolveRecurrence } from '../calendar/recurrence';
import { DB, type Db } from '../core/database/database.module';
import type { BlockSeriesRow } from '../core/database/schema';
import type { ErrorCode } from '../core/http/error-code';
import {
  recurrenceOf,
  toBlockOccurrence,
  type BlockOccurrence,
} from './blocks.mapper';
import { BlocksRepository } from './blocks.repository';
import type { CreateBlockBody } from './dto/create-block.dto';

/** BLK-05's lower bound. */
const MIN_BLOCK_MINUTES = 5;

@Injectable()
export class BlocksService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly blocks: BlocksRepository,
  ) {}

  /**
   * Creates a block series and returns its first occurrence: the first day on
   * or after `date` that the recurrence lands on. That is `date` itself unless
   * the rule skips it, e.g. a weekly block of Mondays created on a Wednesday.
   *
   * A retry carrying the same `idempotencyKey` returns the series the first
   * request created, as that request would have, whatever the retry's body
   * says: the key names the operation, not its content.
   *
   * It does not read the session. Like every route but `/me`, it trusts the
   * stateless guard (decision 16).
   */
  async create(
    caller: Caller,
    body: CreateBlockBody,
  ): Promise<BlockOccurrence> {
    if (lengthInMinutes(body.startMin, body.endMin) < MIN_BLOCK_MINUTES) {
      throw new UnprocessableEntityException({
        code: 'BLOCK_TOO_SHORT' satisfies ErrorCode,
        message: `A block lasts at least ${MIN_BLOCK_MINUTES} minutes.`,
      });
    }

    const recurrence = resolveRecurrence(body.recurrence, body.date);
    if (firstOccurrenceFrom(recurrence, body.date, body.date) === null) {
      throw new UnprocessableEntityException({
        code: 'BLOCK_NO_OCCURRENCE' satisfies ErrorCode,
        message: 'The repeat ends before the block falls on any day.',
      });
    }

    const { row } = await this.blocks.create(this.db, {
      userId: caller.userId,
      name: body.name,
      anchorDate: body.date,
      startMin: body.startMin,
      endMin: body.endMin,
      recurrenceKind: recurrence.kind,
      weekdays: recurrence.weekdays,
      monthDays: recurrence.monthDays,
      until: recurrence.until,
      alert: body.alert,
      idempotencyKey: body.idempotencyKey,
    });

    // Recomputed from the row, not the body: a replay returns the series the
    // first request stored, whatever the retry sent.
    return toBlockOccurrence(row, firstOccurrenceOf(row));
  }
}

/**
 * A block's length, counting a midnight crossing (BLK-04). `end = start` is a
 * full day rather than nothing.
 */
export function lengthInMinutes(startMin: number, endMin: number): number {
  return endMin > startMin ? endMin - startMin : 1440 - startMin + endMin;
}

/**
 * The series' first occurrence. Every stored series has one: `create` refuses
 * a recurrence that never lands before its `until`.
 */
function firstOccurrenceOf(row: BlockSeriesRow): string {
  const date = firstOccurrenceFrom(
    recurrenceOf(row),
    row.anchorDate,
    row.anchorDate,
  );
  if (date === null) throw new Error(`block series ${row.id} never occurs`);
  return date;
}
