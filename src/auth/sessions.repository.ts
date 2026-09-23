import { Injectable } from '@nestjs/common';
import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import type { Executor, Tx } from '../database/database.module';
import {
  sessionRefreshTokens,
  sessions,
  type SessionRow,
  type SignInMethod,
} from '../database/schema';

/** `n` days as an interval. The cast gives Postgres the parameter's type. */
function days(n: number): SQL {
  return sql`(${n}::integer * interval '1 day')`;
}

export type LockedSession = SessionRow & { expired: boolean };

/** A token this session rotated away from, and whether a retry may still use it. */
export interface RetiredToken {
  /** The last token retired, less than `graceSeconds` ago. */
  inGrace: boolean;
}

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
        expiresAt: sql`now() + ${days(input.ttlDays)}`,
      })
      .returning();

    if (row === undefined) throw new Error('insert returned no row');

    return row;
  }

  /**
   * The session a refresh token belongs to — as its current token or as one
   * it has retired — row-locked until the transaction ends, with whether it
   * has expired judged on the database's clock.
   *
   * The lock is what makes rotation safe: two refreshes presenting the same
   * token queue here, and the second reads the row the first left behind.
   * The caller then compares `refreshTokenHash` itself, rather than this
   * query reporting which table matched — a verdict computed before the wait
   * would describe a token that has since been rotated.
   */
  async lockByTokenHash(
    tx: Tx,
    tokenHash: string,
  ): Promise<LockedSession | null> {
    const t = sessions;
    const r = sessionRefreshTokens;
    const [row] = await tx
      .select({
        id: t.id,
        userId: t.userId,
        signInMethod: t.signInMethod,
        refreshTokenHash: t.refreshTokenHash,
        expiresAt: t.expiresAt,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
        expired: sql<boolean>`${t.expiresAt} <= now()`,
      })
      .from(t)
      .where(
        sql`${t.id} = (
          SELECT ${t.id} FROM ${t} WHERE ${t.refreshTokenHash} = ${tokenHash}
          UNION ALL
          SELECT ${r.sessionId} FROM ${r} WHERE ${r.tokenHash} = ${tokenHash}
          LIMIT 1
        )`,
      )
      .limit(1)
      .for('update');

    return row ?? null;
  }

  /**
   * Whether `tokenHash` is one this session has retired, and if so whether it
   * is still inside the retry grace window: the most recently retired token,
   * retired less than `graceSeconds` ago. `null` when it is not one of the
   * session's.
   *
   * Call it with the session locked, so no rotation lands between this and
   * what the caller does with the answer.
   */
  async findRetiredToken(
    tx: Tx,
    sessionId: string,
    tokenHash: string,
    graceSeconds: number,
  ): Promise<RetiredToken | null> {
    const r = sessionRefreshTokens;
    const [latest] = await tx
      .select({
        tokenHash: r.tokenHash,
        recent: sql<boolean>`${r.retiredAt} > clock_timestamp() - (${graceSeconds}::integer * interval '1 second')`,
      })
      .from(r)
      .where(eq(r.sessionId, sessionId))
      .orderBy(desc(r.retiredAt))
      .limit(1);

    if (latest?.tokenHash === tokenHash) return { inGrace: latest.recent };

    const [older] = await tx
      .select({ id: r.id })
      .from(r)
      .where(and(eq(r.sessionId, sessionId), eq(r.tokenHash, tokenHash)))
      .limit(1);

    return older === undefined ? null : { inGrace: false };
  }

  /**
   * Replaces the session's current refresh token with `newTokenHash`,
   * recording the old one as retired, and slides the expiry to `ttlDays`
   * from now. Both writes or neither, so it takes a `Tx`.
   */
  async rotate(
    tx: Tx,
    session: Pick<SessionRow, 'id' | 'refreshTokenHash'>,
    newTokenHash: string,
    ttlDays: number,
  ): Promise<SessionRow> {
    await tx.insert(sessionRefreshTokens).values({
      sessionId: session.id,
      tokenHash: session.refreshTokenHash,
    });

    const [row] = await tx
      .update(sessions)
      .set({
        refreshTokenHash: newTokenHash,
        expiresAt: sql`now() + ${days(ttlDays)}`,
      })
      .where(eq(sessions.id, session.id))
      .returning();

    if (row === undefined) throw new Error('locked session row vanished');

    return row;
  }

  /**
   * A session that has not expired, judged on the database's clock, or `null`.
   * Not locked: for reads that only need to know the session still stands.
   */
  async findLiveById(ex: Executor, id: string): Promise<SessionRow | null> {
    const [row] = await ex
      .select()
      .from(sessions)
      .where(and(eq(sessions.id, id), sql`${sessions.expiresAt} > now()`))
      .limit(1);

    return row ?? null;
  }

  /** Ends a session. Its retired tokens go with it (cascade). */
  async deleteById(ex: Executor, id: string): Promise<void> {
    await ex.delete(sessions).where(eq(sessions.id, id));
  }

  /**
   * Ends the session `tokenHash` is the current token of, if any. A retired
   * or unknown token deletes nothing: sign-out is idempotent.
   */
  async deleteByTokenHash(ex: Executor, tokenHash: string): Promise<void> {
    await ex.delete(sessions).where(eq(sessions.refreshTokenHash, tokenHash));
  }
}
