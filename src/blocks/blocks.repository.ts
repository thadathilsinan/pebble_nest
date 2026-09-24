import { Injectable } from '@nestjs/common';
import { and, eq, gte, isNull, lte, or } from 'drizzle-orm';
import type { Executor } from '../core/database/database.module';
import { blockSeries, type BlockSeriesRow } from '../core/database/schema';

/** The columns `POST /blocks` writes. */
export type NewBlockSeries = Pick<
  BlockSeriesRow,
  | 'userId'
  | 'name'
  | 'anchorDate'
  | 'startMin'
  | 'endMin'
  | 'recurrenceKind'
  | 'weekdays'
  | 'monthDays'
  | 'until'
  | 'alert'
> & { idempotencyKey?: string };

@Injectable()
export class BlocksRepository {
  /**
   * Inserts a series, or returns the one an earlier request with the same
   * idempotency key created (schema-conventions §9). `created` is false for
   * that replay.
   *
   * Insert-first, like `UsersRepository.findOrCreateByEmail`: the scoped
   * unique index decides between two racing retries. The loser's
   * `ON CONFLICT DO NOTHING` waits for the winner to commit, and the select
   * after it takes a fresh snapshot under READ COMMITTED, so the winner's row
   * is always there to return. That is why no "in progress" answer exists: the
   * insert is a single statement, never held open inside a longer transaction.
   */
  async create(
    ex: Executor,
    values: NewBlockSeries,
  ): Promise<{ row: BlockSeriesRow; created: boolean }> {
    const [created] = await ex
      .insert(blockSeries)
      .values(values)
      .onConflictDoNothing({
        target: [blockSeries.userId, blockSeries.idempotencyKey],
      })
      .returning();

    if (created !== undefined) return { row: created, created: true };

    // Only a repeated key conflicts: a null key never does.
    const key = values.idempotencyKey;
    if (key === undefined) throw new Error('insert without a key conflicted');

    const [existing] = await ex
      .select()
      .from(blockSeries)
      .where(
        and(
          eq(blockSeries.userId, values.userId),
          eq(blockSeries.idempotencyKey, key),
        ),
      )
      .limit(1);

    // The conflict proved the row existed a statement ago. Absent now means it
    // was deleted in between, which a caller cannot act on.
    if (existing === undefined) {
      throw new Error(
        'block series vanished between insert conflict and select',
      );
    }

    return { row: existing, created: false };
  }

  /**
   * One of the user's series. Someone else's id reads as absent, so an id
   * never tells a caller whether another user's block exists.
   */
  async findById(
    ex: Executor,
    userId: string,
    id: string,
  ): Promise<BlockSeriesRow | null> {
    const [row] = await ex
      .select()
      .from(blockSeries)
      .where(and(eq(blockSeries.userId, userId), eq(blockSeries.id, id)))
      .limit(1);

    return row ?? null;
  }

  /**
   * The user's series that may have an occurrence starting between `from` and
   * `to`, both inclusive: begun by `to`, and not ended before `from`. Which
   * days in the range each one lands on is `occursOn`'s job, not SQL's.
   *
   * Uses `uq_block_series_user_id_idempotency_key`, which leads with
   * `user_id`. A user's series are few enough that filtering the dates after
   * that is cheap; an index on `(user_id, anchor_date)` is the step up if not.
   */
  findActiveBetween(
    ex: Executor,
    userId: string,
    from: string,
    to: string,
  ): Promise<BlockSeriesRow[]> {
    return ex
      .select()
      .from(blockSeries)
      .where(
        and(
          eq(blockSeries.userId, userId),
          lte(blockSeries.anchorDate, to),
          or(isNull(blockSeries.until), gte(blockSeries.until, from)),
        ),
      );
  }
}
