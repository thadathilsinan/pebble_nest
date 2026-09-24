import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
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
}
