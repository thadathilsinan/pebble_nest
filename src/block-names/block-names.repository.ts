import { Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Executor } from '../core/database/database.module';
import {
  blockNameTraces,
  blockSeries,
  type BlockNameTraceRow,
  type ChosenTrace,
} from '../core/database/schema';

@Injectable()
export class BlockNamesRepository {
  /**
   * Every name the user has given a block, one spelling per name ignoring
   * capitals, most recently used first. The spelling is the one the most
   * recent series used, as in the app. "Recently used" is when the series was
   * created, which a UUIDv7 id orders.
   *
   * Uses `uq_block_series_user_id_idempotency_key`, which leads with
   * `user_id`. The answer is one row per distinct name, which stays small
   * however many blocks the user has made.
   */
  async findNamesByRecentUse(ex: Executor, userId: string): Promise<string[]> {
    const nameKey = sql`lower(${blockSeries.name})`;
    const latest = ex
      .selectDistinctOn([nameKey], {
        name: blockSeries.name,
        id: blockSeries.id,
      })
      .from(blockSeries)
      .where(eq(blockSeries.userId, userId))
      .orderBy(nameKey, desc(blockSeries.id))
      .as('latest');

    const rows = await ex
      .select({ name: latest.name })
      .from(latest)
      .orderBy(desc(latest.id));

    return rows.map((row) => row.name);
  }

  /**
   * The user's chosen traces: every one, or only those for `nameKeys` when
   * given.
   */
  findTraces(
    ex: Executor,
    userId: string,
    nameKeys?: string[],
  ): Promise<Pick<BlockNameTraceRow, 'nameKey' | 'trace'>[]> {
    return ex
      .select({
        nameKey: blockNameTraces.nameKey,
        trace: blockNameTraces.trace,
      })
      .from(blockNameTraces)
      .where(
        and(
          eq(blockNameTraces.userId, userId),
          nameKeys === undefined
            ? undefined
            : inArray(blockNameTraces.nameKey, nameKeys),
        ),
      );
  }

  /** Records `trace` as the one `nameKey` is drawn in, replacing any other. */
  async setTrace(
    ex: Executor,
    userId: string,
    nameKey: string,
    trace: ChosenTrace,
  ): Promise<void> {
    await ex
      .insert(blockNameTraces)
      .values({ userId, nameKey, trace })
      .onConflictDoUpdate({
        target: [blockNameTraces.userId, blockNameTraces.nameKey],
        set: { trace },
      });
  }

  /** Forgets the trace chosen for `nameKey`, if there is one. */
  async clearTrace(
    ex: Executor,
    userId: string,
    nameKey: string,
  ): Promise<void> {
    await ex
      .delete(blockNameTraces)
      .where(
        and(
          eq(blockNameTraces.userId, userId),
          eq(blockNameTraces.nameKey, nameKey),
        ),
      );
  }
}
