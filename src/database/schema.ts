/**
 * The TypeScript description of this database's shape, and the source of truth
 * for everything `drizzle-kit`'s DSL can express.
 *
 * Two things import it. `drizzle-kit` diffs it against the snapshot in
 * `drizzle/meta/` to generate migrations, and `database.module.ts` passes it to
 * `drizzle(pool, { schema })`, where it becomes the `Schema` type parameter.
 *
 * Two things need saying rather than assuming:
 *
 * - This file describes only what the DSL can express. Triggers, deferrable
 *   constraints and grants — the invariants that matter most — live in
 *   hand-written SQL inside migrations, invisible to the snapshot
 *   `drizzle-kit` diffs against. The register in `docs/database-decisions.md`
 *   lists them; reading this file as a complete description of the database
 *   will be wrong about exactly those. Every table below with an `updated_at`
 *   has a `trg_<table>_updated_at` trigger that is not declared here.
 * - Editing this file changes nothing on its own. A change here is inert until
 *   `npm run db:migrate:create` turns it into SQL and `npm run db:migrate`
 *   applies it.
 */

import { sql, type SQL } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * `col IN ('a', 'b')` built from the same `as const` array that types the
 * column, so the check constraint and the TypeScript union cannot drift —
 * `docs/schema-conventions.md` §5. `sql.raw` is safe here only because every
 * caller passes a compile-time constant from this file, never input.
 */
function oneOf(column: SQL, values: readonly string[]): SQL {
  return sql`${column} IN (${sql.raw(values.map((v) => `'${v}'`).join(', '))})`;
}

export const WEEK_STARTS = ['monday', 'sunday'] as const;
export const TIME_FORMATS = ['system', 'h24', 'h12'] as const;
export const SIGN_IN_METHODS = ['google', 'apple', 'email'] as const;

export type WeekStart = (typeof WEEK_STARTS)[number];
export type TimeFormat = (typeof TIME_FORMATS)[number];
export type SignInMethod = (typeof SIGN_IN_METHODS)[number];

/**
 * One account. ACC-03: the verified email *is* the account, whichever method
 * signed in, so `email` is unique and stored lower-cased — the check makes a
 * mixed-case write fail rather than open a second account.
 */
export const users = pgTable(
  'users',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    email: text('email').notNull(),
    // Nullable: decision 10 in docs/api-plan.md — a name is optional and never
    // asked for. Google and Apple fill it in when they can.
    name: text('name'),
    weekStart: text('week_start', { enum: WEEK_STARTS })
      .notNull()
      .default('monday'),
    timeFormat: text('time_format', { enum: TIME_FORMATS })
      .notNull()
      .default('system'),
    // Nullable: unknown until the client first reports it, which it does
    // silently on every app open (PATCH /me).
    timeZone: text('time_zone'),
    // schema-conventions §10: the profile is edited through PATCH /me from more
    // than one device.
    version: integer('version').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('uq_users_email').on(table.email),
    check(
      'ck_users_email_lowercase',
      sql`${table.email} = lower(${table.email})`,
    ),
    check('ck_users_week_start', oneOf(sql`${table.weekStart}`, WEEK_STARTS)),
    check(
      'ck_users_time_format',
      oneOf(sql`${table.timeFormat}`, TIME_FORMATS),
    ),
  ],
);

export type UserRow = typeof users.$inferSelect;

/**
 * The live sign-in code for an email address (ACC-02), and the send counters
 * that rate-limit `/auth/email/code`.
 *
 * One row per email, replaced on every send. A used code is not deleted: its
 * `expires_at` is pulled back to the moment of use, which kills it while
 * keeping the send counters — deleting would reset the hourly limit.
 *
 * Keyed on email rather than on a user, because a code is requested before any
 * account exists. No `version`: every write is either a single atomic
 * statement or runs under `SELECT … FOR UPDATE` (schema-conventions §10's
 * named exception), since two verifies racing must not share an attempt.
 */
export const emailSignInCodes = pgTable(
  'email_sign_in_codes',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    email: text('email').notNull(),
    // HMAC-SHA256 of the code under SIGN_IN_CODE_SECRET. The code itself is
    // never stored: a read of this table must not be a way to sign in.
    codeHash: text('code_hash').notNull(),
    attempts: integer('attempts').notNull().default(0),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastSentAt: timestamp('last_sent_at', { withTimezone: true }).notNull(),
    // The fixed rate-limit window: it opens with the first send and resets on
    // the first send after it has lasted an hour.
    windowStartedAt: timestamp('window_started_at', {
      withTimezone: true,
    }).notNull(),
    sendsInWindow: integer('sends_in_window').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('uq_email_sign_in_codes_email').on(table.email),
    check(
      'ck_email_sign_in_codes_email_lowercase',
      sql`${table.email} = lower(${table.email})`,
    ),
    check(
      'ck_email_sign_in_codes_attempts_non_negative',
      sql`${table.attempts} >= 0`,
    ),
    check(
      'ck_email_sign_in_codes_sends_positive',
      sql`${table.sendsInWindow} > 0`,
    ),
  ],
);

export type EmailSignInCodeRow = typeof emailSignInCodes.$inferSelect;

/**
 * One signed-in device: the refresh token it holds, and how it signed in.
 *
 * `sign_in_method` lives here rather than on `users` because ACC-03 lets one
 * account be reached by several methods; `Profile.signInMethod` reports the
 * current device's.
 *
 * The refresh token is stored as its SHA-256 only — a leaked table must not be
 * a set of live sessions. No `version`: nothing edits a session through a
 * read-modify-write yet. Rotation (`/auth/refresh`) will be a conditional
 * update on the hash, which is its own optimistic check.
 */
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    userId: uuid('user_id').notNull(),
    signInMethod: text('sign_in_method', { enum: SIGN_IN_METHODS }).notNull(),
    refreshTokenHash: text('refresh_token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Cascade: a session is part of its account — DELETE /me (ACC-06) is a hard
    // delete of everything, and a session outliving its user is a live token
    // for nobody. Declared here rather than with `.references()` so it can be
    // named (schema-conventions §1).
    foreignKey({
      name: 'fk_sessions_user_id',
      columns: [table.userId],
      foreignColumns: [users.id],
    }).onDelete('cascade'),
    // Refresh and sign-out find the session by the token they are handed.
    uniqueIndex('uq_sessions_refresh_token_hash').on(table.refreshTokenHash),
    // schema-conventions §6: the foreign key column, for the cascade's scan.
    index('idx_sessions_user_id').on(table.userId),
    check(
      'ck_sessions_sign_in_method',
      oneOf(sql`${table.signInMethod}`, SIGN_IN_METHODS),
    ),
  ],
);

export type SessionRow = typeof sessions.$inferSelect;
