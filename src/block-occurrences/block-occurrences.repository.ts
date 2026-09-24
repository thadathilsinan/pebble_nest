import { Injectable } from '@nestjs/common';
import { and, eq, gte, lte, notExists } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Executor } from '../core/database/database.module';
import {
  blockOccurrenceExceptions,
  type BlockOccurrenceExceptionRow,
} from '../core/database/schema';

/** What editing only one occurrence overrides; null follows the series. */
export type OccurrenceOverrides = Pick<
  BlockOccurrenceExceptionRow,
  'name' | 'startMin' | 'endMin' | 'alert'
>;

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
   * Marks the occurrence deleted (BLK-10), creating its exception row or
   * updating the one there. Deleting is for good: nothing clears it.
   */
  async markDeleted(
    ex: Executor,
    userId: string,
    blockSeriesId: string,
    date: string,
  ): Promise<void> {
    await ex
      .insert(blockOccurrenceExceptions)
      .values({ userId, blockSeriesId, date, deleted: true })
      .onConflictDoUpdate({
        target: [
          blockOccurrenceExceptions.blockSeriesId,
          blockOccurrenceExceptions.date,
        ],
        set: { deleted: true },
      });
  }

  /**
   * Un-skips the occurrence, keeping whatever else its row overrides. An
   * occurrence with no row is left as it is, and so is a deleted one's row.
   */
  async unskip(
    ex: Executor,
    blockSeriesId: string,
    date: string,
  ): Promise<void> {
    await ex
      .update(blockOccurrenceExceptions)
      .set({ skipped: false })
      .where(
        and(
          eq(blockOccurrenceExceptions.blockSeriesId, blockSeriesId),
          eq(blockOccurrenceExceptions.date, date),
          eq(blockOccurrenceExceptions.deleted, false),
        ),
      );
  }

  /**
   * Sets what the occurrence overrides of its series, creating its exception
   * row or replacing every override in the one there; null follows the
   * series. Its skip is left as it is.
   */
  async override(
    ex: Executor,
    userId: string,
    blockSeriesId: string,
    date: string,
    overrides: OccurrenceOverrides,
  ): Promise<BlockOccurrenceExceptionRow> {
    const [row] = await ex
      .insert(blockOccurrenceExceptions)
      .values({ userId, blockSeriesId, date, ...overrides })
      .onConflictDoUpdate({
        target: [
          blockOccurrenceExceptions.blockSeriesId,
          blockOccurrenceExceptions.date,
        ],
        set: overrides,
      })
      .returning();

    if (row === undefined) throw new Error('upsert returned no row');
    return row;
  }

  /** The exception row of the occurrence starting on `date`, if any. */
  async find(
    ex: Executor,
    blockSeriesId: string,
    date: string,
  ): Promise<BlockOccurrenceExceptionRow | null> {
    const [row] = await ex
      .select()
      .from(blockOccurrenceExceptions)
      .where(
        and(
          eq(blockOccurrenceExceptions.blockSeriesId, blockSeriesId),
          eq(blockOccurrenceExceptions.date, date),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /**
   * Gives the exception rows of `fromSeries`' occurrences starting on or
   * after `from` to `toSeries`, for a series split there.
   */
  async moveSeries(
    ex: Executor,
    fromSeries: string,
    toSeries: string,
    from: string,
  ): Promise<void> {
    await ex
      .update(blockOccurrenceExceptions)
      .set({ blockSeriesId: toSeries })
      .where(
        and(
          eq(blockOccurrenceExceptions.blockSeriesId, fromSeries),
          gte(blockOccurrenceExceptions.date, from),
        ),
      );
  }

  /**
   * Moves the exception row of the occurrence starting on `from` to `to`,
   * for an occurrence moved there. An occurrence already on `to` keeps its
   * own row, and `from`'s stays where it was.
   */
  async moveDate(
    ex: Executor,
    blockSeriesId: string,
    from: string,
    to: string,
  ): Promise<void> {
    const there = alias(blockOccurrenceExceptions, 'there');
    await ex
      .update(blockOccurrenceExceptions)
      .set({ date: to })
      .where(
        and(
          eq(blockOccurrenceExceptions.blockSeriesId, blockSeriesId),
          eq(blockOccurrenceExceptions.date, from),
          notExists(
            ex
              .select()
              .from(there)
              .where(
                and(eq(there.blockSeriesId, blockSeriesId), eq(there.date, to)),
              ),
          ),
        ),
      );
  }

  /**
   * The user's exceptions for occurrences starting from `from` to `to`,
   * both included: the skipped, the deleted and the overridden. Uses
   * `idx_block_occurrence_exceptions_user_id_date`.
   */
  findBetween(
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
        ),
      );
  }
}
