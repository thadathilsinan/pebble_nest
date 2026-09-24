import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Executor } from '../../core/database/database.module';
import { appleGrants, type AppleGrantRow } from '../../core/database/schema';

/** What revoking an account's Apple grant needs. */
export type AppleGrant = Pick<AppleGrantRow, 'clientId' | 'refreshToken'>;

@Injectable()
export class AppleGrantsRepository {
  /** Records the account's latest Apple grant, replacing any earlier one. */
  async save(
    ex: Executor,
    userId: string,
    clientId: string,
    refreshToken: string,
  ): Promise<void> {
    await ex
      .insert(appleGrants)
      .values({ userId, clientId, refreshToken })
      .onConflictDoUpdate({
        target: appleGrants.userId,
        set: { clientId, refreshToken },
      });
  }

  async findByUserId(ex: Executor, userId: string): Promise<AppleGrant | null> {
    const [row] = await ex
      .select({
        clientId: appleGrants.clientId,
        refreshToken: appleGrants.refreshToken,
      })
      .from(appleGrants)
      .where(eq(appleGrants.userId, userId));

    return row ?? null;
  }
}
