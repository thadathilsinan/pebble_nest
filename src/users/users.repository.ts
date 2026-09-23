import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Executor } from '../database/database.module';
import { users, type UserRow } from '../database/schema';

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

  async findById(ex: Executor, id: string): Promise<UserRow | null> {
    const [row] = await ex
      .select()
      .from(users)
      .where(eq(users.id, id))
      .limit(1);

    return row ?? null;
  }
}
