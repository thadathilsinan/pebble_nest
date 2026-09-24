import {
  Inject,
  Injectable,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Caller } from '../auth/caller';
import { resolveRecurrence } from '../calendar/recurrence';
import { DB, type Db } from '../database/database.module';
import type { ErrorCode } from '../http/error-code';
import { toBlockOccurrence, type BlockOccurrence } from './blocks.mapper';
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
   * Creates a block series and returns its first occurrence, on `date`.
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

    return toBlockOccurrence(row, row.anchorDate);
  }
}

/**
 * A block's length, counting a midnight crossing (BLK-04). `end = start` is a
 * full day rather than nothing.
 */
export function lengthInMinutes(startMin: number, endMin: number): number {
  return endMin > startMin ? endMin - startMin : 1440 - startMin + endMin;
}
