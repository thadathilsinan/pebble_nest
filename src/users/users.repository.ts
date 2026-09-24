import { Injectable } from '@nestjs/common';
import { and, eq, or, sql, type SQL } from 'drizzle-orm';
import type { Executor } from '../database/database.module';
import { users, type UserRow } from '../database/schema';

/** The profile fields `PATCH /me` may write. */
export type ProfilePatch = Partial<
  Pick<UserRow, 'name' | 'weekStart' | 'timeFormat' | 'timeZone'>
>;

/**
 * The verdict of a versioned update (`docs/adding-a-feature.md` §6.3).
 * `updated` also covers a patch that changed nothing, and its row then has the
 * version the caller sent.
 */
export type VersionedUpdate =
  | { outcome: 'updated'; row: UserRow }
  | { outcome: 'stale'; row: UserRow }
  | { outcome: 'missing' };

@Injectable()
export class UsersRepository {
  /**
   * The account for a verified email, opening one if none exists (ACC-03:
   * the email is the account, whichever method proved it).
   *
   * Insert-first rather than select-first, so two sign-ins racing for a new
   * email cannot both decide to create: the unique index picks one, and the
   * loser's `ON CONFLICT DO NOTHING` waits for the winner to commit and then
   * returns nothing. Under READ COMMITTED the select after it takes a fresh
   * snapshot, which includes the winner's row.
   *
   * `email` must already be lower-cased; `ck_users_email_lowercase` rejects
   * anything else rather than opening a second account for `Me@x.com`.
   */
  async findOrCreateByEmail(
    ex: Executor,
    email: string,
  ): Promise<{ row: UserRow; created: boolean }> {
    const [created] = await ex
      .insert(users)
      .values({ email })
      .onConflictDoNothing({ target: users.email })
      .returning();

    if (created !== undefined) return { row: created, created: true };

    const [existing] = await ex
      .select()
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    // The conflict proved the row existed a statement ago. Absent now means it
    // was deleted in between — ACC-06 racing a sign-in — which a caller cannot
    // act on, so it fails loudly rather than inventing an answer.
    if (existing === undefined) {
      throw new Error('user vanished between insert conflict and select');
    }

    return { row: existing, created: false };
  }

  /**
   * Applies `patch` if the row is still at `version`, bumping it by one.
   *
   * A patch that would change nothing is not written, so it leaves `version`
   * and `updated_at` alone. Otherwise every no-op save on one device would make
   * the other devices' versions stale. The `IS DISTINCT FROM` test sits in the
   * same `WHERE` as the version predicate, so a zero-row update has three
   * possible causes. The re-read tells them apart: no row is `missing`, a row
   * still at `version` means nothing changed, and any other version is `stale`.
   *
   * No transaction, deliberately: see `docs/adding-a-feature.md` §6.3.
   */
  async updateVersioned(
    ex: Executor,
    id: string,
    version: number,
    patch: ProfilePatch,
  ): Promise<VersionedUpdate> {
    const changes = changedFrom(patch);

    if (changes !== undefined) {
      const [row] = await ex
        .update(users)
        .set({ ...patch, version: sql`${users.version} + 1` })
        .where(and(eq(users.id, id), eq(users.version, version), changes))
        .returning();

      if (row !== undefined) return { outcome: 'updated', row };
    }

    const current = await this.findById(ex, id);

    if (current === null) return { outcome: 'missing' };

    return current.version === version
      ? { outcome: 'updated', row: current }
      : { outcome: 'stale', row: current };
  }

  /**
   * Records the time zone the device reports. Last write wins, with no version
   * check: it is a fact the device reports on every app open, not an edit, and
   * it must never fail with a 409 (decision 17 in `docs/api-plan.md`).
   *
   * An actual change still bumps `version`, because the profile changed. A
   * repeat of the zone already stored writes nothing, which is the common case.
   * Returns `null` when the account is gone.
   */
  async setTimeZone(
    ex: Executor,
    id: string,
    timeZone: string,
  ): Promise<UserRow | null> {
    const [row] = await ex
      .update(users)
      .set({ timeZone, version: sql`${users.version} + 1` })
      .where(
        and(
          eq(users.id, id),
          sql`${users.timeZone} IS DISTINCT FROM ${timeZone}`,
        ),
      )
      .returning();

    return row ?? (await this.findById(ex, id));
  }

  /**
   * Hard-deletes the account (ACC-06). Its sessions and their retired tokens
   * go with it through the cascades on `sessions` and
   * `session_refresh_tokens`. Returns the deleted row so the caller can clean up
   * what is keyed by email, or `null` when there was no such account.
   */
  async deleteById(ex: Executor, id: string): Promise<UserRow | null> {
    const [row] = await ex.delete(users).where(eq(users.id, id)).returning();

    return row ?? null;
  }

  async findById(ex: Executor, id: string): Promise<UserRow | null> {
    const [row] = await ex
      .select()
      .from(users)
      .where(eq(users.id, id))
      .limit(1);

    return row ?? null;
  }
}

/**
 * `col IS DISTINCT FROM value` for each field in the patch, OR-ed together: true
 * when writing the patch would change the row. `IS DISTINCT FROM` rather than
 * `<>` because `name` and `time_zone` are nullable, and `NULL <> 'x'` is null,
 * not true. `undefined` for an empty patch, which has nothing to write.
 */
function changedFrom(patch: ProfilePatch): SQL | undefined {
  const columns = {
    name: users.name,
    weekStart: users.weekStart,
    timeFormat: users.timeFormat,
    timeZone: users.timeZone,
  } as const;

  const tests = (Object.keys(columns) as (keyof ProfilePatch)[])
    .filter((key) => patch[key] !== undefined)
    .map((key) => sql`${columns[key]} IS DISTINCT FROM ${patch[key]}`);

  return tests.length === 0 ? undefined : or(...tests);
}
