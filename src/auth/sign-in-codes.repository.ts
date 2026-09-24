import { Injectable } from '@nestjs/common';
import { eq, sql, type SQL } from 'drizzle-orm';
import type { Executor, Tx } from '../database/database.module';
import { emailSignInCodes, type EmailSignInCodeRow } from '../database/schema';

/** `n` seconds as an interval. The cast gives Postgres the parameter's type. */
function seconds(n: number): SQL {
  return sql`(${n}::integer * interval '1 second')`;
}

/** The limits a send is checked against. The service owns the numbers. */
export interface SendLimits {
  /** How long a code stays usable. */
  ttlSeconds: number;
  /** The minimum gap between two sends to one email. */
  cooldownSeconds: number;
  /** The length of the fixed window `maxSendsPerWindow` counts over. */
  windowSeconds: number;
  maxSendsPerWindow: number;
}

export type IssueOutcome =
  { outcome: 'issued' } | { outcome: 'limited'; retryAfterSeconds: number };

export type LockedCode = EmailSignInCodeRow & { expired: boolean };

@Injectable()
export class SignInCodesRepository {
  /**
   * Stores a new code for `email`, replacing any earlier one and resetting its
   * attempts, **unless the send limits refuse it** — in which case nothing is
   * written and the caller is told how long to wait.
   *
   * The check and the write are one statement, and that is the point. A
   * separate "may I send?" read would let two concurrent requests both see
   * room for one more send and both send. `ON CONFLICT DO UPDATE … WHERE`
   * locks the existing row before evaluating the condition, so concurrent
   * sends to one email queue behind each other and each sees the last one's
   * counters.
   *
   * Every time here is the database's `now()`, never Node's clock, so the
   * cooldown and the window are measured on one clock across instances.
   */
  async issue(
    ex: Executor,
    email: string,
    codeHash: string,
    limits: SendLimits,
  ): Promise<IssueOutcome> {
    const t = emailSignInCodes;
    const windowOver = sql`${t.windowStartedAt} <= now() - ${seconds(limits.windowSeconds)}`;

    const [row] = await ex
      .insert(t)
      .values({
        email,
        codeHash,
        attempts: 0,
        expiresAt: sql`now() + ${seconds(limits.ttlSeconds)}`,
        lastSentAt: sql`now()`,
        windowStartedAt: sql`now()`,
        sendsInWindow: 1,
      })
      .onConflictDoUpdate({
        target: t.email,
        set: {
          codeHash,
          attempts: 0,
          expiresAt: sql`now() + ${seconds(limits.ttlSeconds)}`,
          lastSentAt: sql`now()`,
          windowStartedAt: sql`CASE WHEN ${windowOver} THEN now() ELSE ${t.windowStartedAt} END`,
          sendsInWindow: sql`CASE WHEN ${windowOver} THEN 1 ELSE ${t.sendsInWindow} + 1 END`,
        },
        setWhere: sql`${t.lastSentAt} <= now() - ${seconds(limits.cooldownSeconds)}
          AND (${windowOver} OR ${t.sendsInWindow} < ${limits.maxSendsPerWindow})`,
      })
      .returning({ id: t.id });

    if (row !== undefined) return { outcome: 'issued' };

    return {
      outcome: 'limited',
      retryAfterSeconds: await this.retryAfterSeconds(ex, email, limits),
    };
  }

  /**
   * How long until a refused send would succeed: the later of the cooldown
   * ending and, if the window is full, the window ending. At least 1, so a
   * refusal never tells the caller to retry immediately.
   */
  private async retryAfterSeconds(
    ex: Executor,
    email: string,
    limits: SendLimits,
  ): Promise<number> {
    const t = emailSignInCodes;
    const [row] = await ex
      .select({
        seconds: sql<number>`ceil(greatest(
          extract(epoch FROM ${t.lastSentAt} + ${seconds(limits.cooldownSeconds)} - now()),
          CASE WHEN ${t.sendsInWindow} >= ${limits.maxSendsPerWindow}
            THEN extract(epoch FROM ${t.windowStartedAt} + ${seconds(limits.windowSeconds)} - now())
            ELSE 0 END,
          1
        ))::integer`,
      })
      .from(t)
      .where(eq(t.email, email))
      .limit(1);

    // Refused means the row existed; if it has gone since, a retry now is
    // exactly right.
    return row?.seconds ?? 1;
  }

  /**
   * The code for `email`, row-locked until the transaction ends, with whether
   * it has expired judged on the database's clock.
   *
   * Takes a `Tx` rather than any `Executor`: a `FOR UPDATE` outside a
   * transaction releases its lock the moment the statement ends, which would
   * let two verifies both read `attempts = 4` and both get a fifth try.
   */
  async lockByEmail(tx: Tx, email: string): Promise<LockedCode | null> {
    const t = emailSignInCodes;
    const [row] = await tx
      .select({
        id: t.id,
        email: t.email,
        codeHash: t.codeHash,
        attempts: t.attempts,
        expiresAt: t.expiresAt,
        lastSentAt: t.lastSentAt,
        windowStartedAt: t.windowStartedAt,
        sendsInWindow: t.sendsInWindow,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
        expired: sql<boolean>`${t.expiresAt} <= now()`,
      })
      .from(t)
      .where(eq(t.email, email))
      .limit(1)
      .for('update');

    return row ?? null;
  }

  /** Counts one wrong guess. Returns the attempts used so far, this one included. */
  async recordFailedAttempt(tx: Tx, id: string): Promise<number> {
    const [row] = await tx
      .update(emailSignInCodes)
      .set({ attempts: sql`${emailSignInCodes.attempts} + 1` })
      .where(eq(emailSignInCodes.id, id))
      .returning({ attempts: emailSignInCodes.attempts });

    if (row === undefined) throw new Error('locked sign-in code row vanished');

    return row.attempts;
  }

  /**
   * Kills a code that has just been used, so it signs in exactly once. The row
   * stays, because its send counters are what rate-limit the next request.
   */
  async consume(tx: Tx, id: string): Promise<void> {
    await tx
      .update(emailSignInCodes)
      .set({ expiresAt: sql`now()` })
      .where(eq(emailSignInCodes.id, id));
  }

  /**
   * Removes the row for `email`, send counters included. Only `DELETE /me`
   * does this (ACC-06: every trace of the account goes). It resets the email's
   * send rate limit, which is an accepted cost.
   */
  async deleteByEmail(ex: Executor, email: string): Promise<void> {
    await ex.delete(emailSignInCodes).where(eq(emailSignInCodes.email, email));
  }
}
