import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Executor } from '../database/database.module';
import {
  sessions,
  type SessionRow,
  type SignInMethod,
} from '../database/schema';

@Injectable()
export class SessionsRepository {
  /**
   * Opens a session for one device. `expires_at` is set from the database's
   * clock, like every other time the auth tables compare against.
   */
  async create(
    ex: Executor,
    input: {
      userId: string;
      signInMethod: SignInMethod;
      refreshTokenHash: string;
      ttlDays: number;
    },
  ): Promise<SessionRow> {
    const [row] = await ex
      .insert(sessions)
      .values({
        userId: input.userId,
        signInMethod: input.signInMethod,
        refreshTokenHash: input.refreshTokenHash,
        expiresAt: sql`now() + (${input.ttlDays}::integer * interval '1 day')`,
      })
      .returning();

    if (row === undefined) throw new Error('insert returned no row');

    return row;
  }
}
