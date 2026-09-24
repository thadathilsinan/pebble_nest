import { Inject, Injectable } from '@nestjs/common';
import type { Caller } from '../auth/caller';
import { normaliseBlockName, tracesByName } from '../block-names/block-name';
import { BlockNamesRepository } from '../block-names/block-names.repository';
import { firstOccurrenceFrom, resolveRecurrence } from '../calendar/recurrence';
import { DB, type Db } from '../core/database/database.module';
import type { BlockSeriesRow } from '../core/database/schema';
import { assertLongEnough, noOccurrence } from './block-occurrence';
import {
  recurrenceOf,
  toBlockOccurrence,
  type BlockOccurrence,
} from './blocks.mapper';
import { BlocksRepository } from './blocks.repository';
import type { CreateBlockBody } from './dto/create-block.dto';

@Injectable()
export class BlocksService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly blocks: BlocksRepository,
    private readonly names: BlockNamesRepository,
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
    assertLongEnough(body);

    const recurrence = resolveRecurrence(body.recurrence, body.date);
    if (firstOccurrenceFrom(recurrence, body.date, body.date) === null) {
      throw noOccurrence();
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
    const traces = await this.names.findTraces(this.db, caller.userId, [
      normaliseBlockName(row.name),
    ]);
    return toBlockOccurrence(row, firstOccurrenceOf(row), tracesByName(traces));
  }
}

/**
 * The series' first occurrence. Every stored series has one: `create` and
 * occurrence edits refuse a recurrence that never lands before its `until`.
 */
export function firstOccurrenceOf(row: BlockSeriesRow): string {
  const date = firstOccurrenceFrom(
    recurrenceOf(row),
    row.anchorDate,
    row.anchorDate,
  );
  if (date === null) throw new Error(`block series ${row.id} never occurs`);
  return date;
}
