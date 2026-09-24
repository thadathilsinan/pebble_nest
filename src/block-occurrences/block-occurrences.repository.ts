import { Injectable } from '@nestjs/common';
import { and, eq, gte, lte } from 'drizzle-orm';
import type { Executor } from '../core/database/database.module';
import {
  blockOccurrenceExceptions,
  type BlockOccurrenceExceptionRow,
} from '../core/database/schema';

@Injectable()
export class BlockOccurrencesRepository {
  /**
   * Marks the occurrence of `blockSeriesId` that starts on `date` skipped,
   * creating its exception row or updating the one there. Skipping twice
   * leaves one row, and the second write changes nothing.
   */
  async skip(
    ex: Executor,
    userId: string,
    blockSeriesId: string,
    date: string,
  ): Promise<void> {
    await ex
      .insert(blockOccurrenceExceptions)
      .values({ userId, blockSeriesId, date, skipped: true })
      .onConflictDoUpdate({
        target: [
          blockOccurrenceExceptions.blockSeriesId,
          blockOccurrenceExceptions.date,
        ],
        set: { skipped: true },
      });
  }

  /**
   * Un-skips the occurrence. Skipping is all an exception holds so far, so
   * that is deleting its row; an occurrence with none is left as it is.
   */
  async unskip(
    ex: Executor,
    blockSeriesId: string,
    date: string,
  ): Promise<void> {
    await ex
      .delete(blockOccurrenceExceptions)
      .where(
        and(
          eq(blockOccurrenceExceptions.blockSeriesId, blockSeriesId),
          eq(blockOccurrenceExceptions.date, date),
        ),
      );
  }

  /**
   * The user's skipped occurrences starting from `from` to `to`, both
   * included. Uses `idx_block_occurrence_exceptions_user_id_date`.
   */
  findSkippedBetween(
    ex: Executor,
    userId: string,
    from: string,
    to: string,
  ): Promise<BlockOccurrenceExceptionRow[]> {
    return ex
      .select()
      .from(blockOccurrenceExceptions)
      .where(
        and(
          eq(blockOccurrenceExceptions.userId, userId),
          gte(blockOccurrenceExceptions.date, from),
          lte(blockOccurrenceExceptions.date, to),
          eq(blockOccurrenceExceptions.skipped, true),
        ),
      );
  }
}
