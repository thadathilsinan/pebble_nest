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
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  pgTable,
  smallint,
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
export const RECURRENCE_KINDS = ['none', 'daily', 'weekly', 'monthly'] as const;

export type WeekStart = (typeof WEEK_STARTS)[number];
export type TimeFormat = (typeof TIME_FORMATS)[number];
export type SignInMethod = (typeof SIGN_IN_METHODS)[number];
export type RecurrenceKind = (typeof RECURRENCE_KINDS)[number];

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
 * a set of live sessions. No `version`: rotation (`/auth/refresh`) runs under
 * `SELECT … FOR UPDATE` on the session row, not a read-modify-write from a
 * client. `expires_at` slides forward on each rotation.
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

/**
 * Every refresh token a session has already rotated away from, kept so that
 * presenting one again is recognised as reuse — the sign that a token was
 * copied — and revokes the whole session, however many rotations ago it was
 * retired. Only hashes, like `sessions`.
 *
 * `retired_at` defaults to `clock_timestamp()` rather than `now()`: a refresh
 * that queued behind another on the session's lock started its transaction
 * first, so `now()` would stamp it earlier than the rotation it followed, and
 * "the most recently retired token" (the one the retry grace window accepts)
 * would come out wrong.
 *
 * No `updated_at`, `version` or `deleted_at`: rows are only ever inserted, and
 * go when their session does.
 */
export const sessionRefreshTokens = pgTable(
  'session_refresh_tokens',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    sessionId: uuid('session_id').notNull(),
    tokenHash: text('token_hash').notNull(),
    retiredAt: timestamp('retired_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (table) => [
    // Cascade: sign-out, reuse revocation and DELETE /me all remove the
    // session, and its history means nothing without it.
    foreignKey({
      name: 'fk_session_refresh_tokens_session_id',
      columns: [table.sessionId],
      foreignColumns: [sessions.id],
    }).onDelete('cascade'),
    // Refresh looks a presented token up here when it is not the current one.
    uniqueIndex('uq_session_refresh_tokens_token_hash').on(table.tokenHash),
    // schema-conventions §6: the foreign key column, for the cascade's scan,
    // and for finding a session's most recently retired token.
    index('idx_session_refresh_tokens_session_id_retired_at').on(
      table.sessionId,
      table.retiredAt,
    ),
  ],
);

export type SessionRefreshTokenRow = typeof sessionRefreshTokens.$inferSelect;

/**
 * A block definition (`docs/api-plan.md` §1). A one-off block is a series of
 * one, with `recurrence_kind = 'none'`; its only occurrence is `anchor_date`.
 *
 * Time is local (decision 6): a date plus minutes from local midnight, with no
 * offset. `end_min <= start_min` means the block crosses midnight (BLK-04), so
 * `end_min = start_min` is a full 24 hours. The length checks below are BLK-05's
 * lower bound; there is no upper-bound check, because minute-of-day start and
 * end cannot describe more than 24 hours.
 *
 * `weekdays` and `month_days` are stored explicitly, never empty for the kind
 * that uses them: an empty set sent by the client means "the anchor's day", and
 * the service fills that in, so readers never need the anchor to interpret a
 * recurrence. The checks keep each array empty for the other kinds.
 */
export const blockSeries = pgTable(
  'block_series',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    userId: uuid('user_id').notNull(),
    name: text('name').notNull(),
    anchorDate: date('anchor_date', { mode: 'string' }).notNull(),
    startMin: smallint('start_min').notNull(),
    endMin: smallint('end_min').notNull(),
    recurrenceKind: text('recurrence_kind', { enum: RECURRENCE_KINDS })
      .notNull()
      .default('none'),
    // 1 = Monday … 7 = Sunday.
    weekdays: smallint('weekdays')
      .array()
      .notNull()
      .default(sql`'{}'`),
    // 1..31. REC-02: a day past a short month's end falls on its last day,
    // which is a read-time rule, so 31 is stored as 31.
    monthDays: smallint('month_days')
      .array()
      .notNull()
      .default(sql`'{}'`),
    // Null means the repeat never ends (REC-03).
    until: date('until', { mode: 'string' }),
    alert: boolean('alert').notNull().default(false),
    // schema-conventions §10: blocks are edited from more than one device.
    version: integer('version').notNull().default(0),
    // schema-conventions §9: POST /blocks may be retried after a lost response.
    idempotencyKey: uuid('idempotency_key'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Cascade: decision 18 — DELETE /me stays a single delete.
    foreignKey({
      name: 'fk_block_series_user_id',
      columns: [table.userId],
      foreignColumns: [users.id],
    }).onDelete('cascade'),
    // Scoped to the owner, so a key is never a way to read someone else's
    // block (schema-conventions §9). A null key never conflicts. It leads with
    // `user_id`, so it is also the foreign key's index (schema-conventions
    // §6): the cascade's scan and reading a user's series both use it.
    uniqueIndex('uq_block_series_user_id_idempotency_key').on(
      table.userId,
      table.idempotencyKey,
    ),
    check(
      'ck_block_series_name_length',
      sql`char_length(${table.name}) BETWEEN 1 AND 60 AND ${table.name} = btrim(${table.name})`,
    ),
    check(
      'ck_block_series_start_min',
      sql`${table.startMin} BETWEEN 0 AND 1439`,
    ),
    check('ck_block_series_end_min', sql`${table.endMin} BETWEEN 0 AND 1439`),
    // BLK-05: at least 5 minutes, counting a midnight crossing.
    check(
      'ck_block_series_min_length',
      sql`(${table.endMin} - ${table.startMin} + 1440) % 1440 >= 5 OR ${table.endMin} = ${table.startMin}`,
    ),
    check(
      'ck_block_series_recurrence_kind',
      oneOf(sql`${table.recurrenceKind}`, RECURRENCE_KINDS),
    ),
    check(
      'ck_block_series_weekdays',
      sql`CASE WHEN ${table.recurrenceKind} = 'weekly'
        THEN cardinality(${table.weekdays}) > 0 AND ${table.weekdays} <@ '{1,2,3,4,5,6,7}'::smallint[]
        ELSE cardinality(${table.weekdays}) = 0 END`,
    ),
    check(
      'ck_block_series_month_days',
      sql`CASE WHEN ${table.recurrenceKind} = 'monthly'
        THEN cardinality(${table.monthDays}) > 0 AND 1 <= ALL(${table.monthDays}) AND 31 >= ALL(${table.monthDays})
        ELSE cardinality(${table.monthDays}) = 0 END`,
    ),
    check(
      'ck_block_series_until',
      sql`${table.until} IS NULL OR (${table.recurrenceKind} <> 'none' AND ${table.until} >= ${table.anchorDate})`,
    ),
  ],
);

export type BlockSeriesRow = typeof blockSeries.$inferSelect;

/**
 * What differs about one occurrence of a block series from the series itself:
 * the occurrence that starts on `date`. A date with no row is the series as
 * it stands.
 *
 * `skipped` (BLK-07/08), `deleted` (BLK-10), and what editing only this
 * occurrence overrode: `name`, `start_min`, `end_min` and `alert`, each null
 * where the occurrence follows its series.
 *
 * No `version` or `idempotency_key`: skipping and deleting set absolute
 * values, so the last write wins and a retry is harmless. An edit is checked
 * against its series' `version`, which it bumps.
 */
export const blockOccurrenceExceptions = pgTable(
  'block_occurrence_exceptions',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    userId: uuid('user_id').notNull(),
    blockSeriesId: uuid('block_series_id').notNull(),
    date: date('date', { mode: 'string' }).notNull(),
    skipped: boolean('skipped').notNull().default(false),
    // The occurrence is gone for good; nothing un-deletes it.
    deleted: boolean('deleted').notNull().default(false),
    // Overrides from editing only this occurrence; null follows the series.
    // Its length (BLK-05) is checked by the service, since it can take one
    // end from the series.
    name: text('name'),
    startMin: smallint('start_min'),
    endMin: smallint('end_min'),
    alert: boolean('alert'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      'ck_block_occurrence_exceptions_name_length',
      sql`${table.name} IS NULL OR (char_length(${table.name}) BETWEEN 1 AND 60 AND ${table.name} = btrim(${table.name}))`,
    ),
    check(
      'ck_block_occurrence_exceptions_start_min',
      sql`${table.startMin} IS NULL OR ${table.startMin} BETWEEN 0 AND 1439`,
    ),
    check(
      'ck_block_occurrence_exceptions_end_min',
      sql`${table.endMin} IS NULL OR ${table.endMin} BETWEEN 0 AND 1439`,
    ),
    // Cascade: decision 18 — DELETE /me stays a single delete.
    foreignKey({
      name: 'fk_block_occurrence_exceptions_user_id',
      columns: [table.userId],
      foreignColumns: [users.id],
    }).onDelete('cascade'),
    // Cascade: an exception means nothing without its series.
    foreignKey({
      name: 'fk_block_occurrence_exceptions_block_series_id',
      columns: [table.blockSeriesId],
      foreignColumns: [blockSeries.id],
    }).onDelete('cascade'),
    // One row per occurrence. It leads with `block_series_id`, so it is also
    // that foreign key's index (schema-conventions §6).
    uniqueIndex('uq_block_occurrence_exceptions_block_series_id_date').on(
      table.blockSeriesId,
      table.date,
    ),
    // GET /days reads a user's exceptions by date range; also the `user_id`
    // foreign key's index.
    index('idx_block_occurrence_exceptions_user_id_date').on(
      table.userId,
      table.date,
    ),
  ],
);

export type BlockOccurrenceExceptionRow =
  typeof blockOccurrenceExceptions.$inferSelect;

export const TASK_LEDGER_OUTCOMES = [
  'completed',
  'incomplete',
  'missed',
] as const;

export type TaskLedgerOutcome = (typeof TASK_LEDGER_OUTCOMES)[number];

/**
 * One dated task (`Task` in `docs/api-plan.md` §1), in a block occurrence or on
 * its date's general list. Repeating tasks add a series table later; each of
 * their occurrences will still be one row here.
 */
export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    userId: uuid('user_id').notNull(),
    // Null is the general list (TSK-02). Otherwise the task sits in the
    // occurrence of this series that starts on `date`.
    blockSeriesId: uuid('block_series_id'),
    date: date('date', { mode: 'string' }).notNull(),
    title: text('title').notNull(),
    notes: text('notes').notNull().default(''),
    // Decision 6: a reminder is a local wall-clock reading with no offset,
    // stored as a date and minutes from its midnight like a block's start,
    // rather than as `timestamp` (schema-conventions §3). Both or neither.
    reminderDate: date('reminder_date', { mode: 'string' }),
    reminderMin: smallint('reminder_min'),
    done: boolean('done').notNull().default(false),
    doneAt: timestamp('done_at', { withTimezone: true }),
    // TSK-06: one more each time the task carries over.
    carryCount: integer('carry_count').notNull().default(0),
    // REC-06/07: recorded against its day and never carried. Only repeating
    // tasks become missed.
    missed: boolean('missed').notNull().default(false),
    // schema-conventions §10: tasks are edited from more than one device.
    version: integer('version').notNull().default(0),
    // schema-conventions §9: POST /tasks may be retried after a lost response.
    idempotencyKey: uuid('idempotency_key'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Cascade: decision 18 — DELETE /me stays a single delete.
    foreignKey({
      name: 'fk_tasks_user_id',
      columns: [table.userId],
      foreignColumns: [users.id],
    }).onDelete('cascade'),
    // Set null: a task outlives its block. BLK-10 moves a deleted block's
    // tasks to the general list, and this is that rule's floor if a series row
    // is ever removed without the block-delete path doing it first.
    foreignKey({
      name: 'fk_tasks_block_series_id',
      columns: [table.blockSeriesId],
      foreignColumns: [blockSeries.id],
    }).onDelete('set null'),
    // Scoped to the owner (schema-conventions §9). It leads with `user_id`,
    // so it is also that foreign key's index (§6).
    uniqueIndex('uq_tasks_user_id_idempotency_key').on(
      table.userId,
      table.idempotencyKey,
    ),
    // GET /days reads a user's tasks by date range.
    index('idx_tasks_user_id_date').on(table.userId, table.date),
    // GET /notifications/schedule reads open reminders by the reminder's own
    // date, which needn't be the task's. Partial: done tasks and tasks with
    // no reminder, most rows, are never scheduled.
    index('idx_tasks_user_id_reminder_date')
      .on(table.userId, table.reminderDate)
      .where(sql`NOT ${table.done} AND ${table.reminderDate} IS NOT NULL`),
    // schema-conventions §6: for the set-null scan when a series is deleted.
    index('idx_tasks_block_series_id').on(table.blockSeriesId),
    // TSK-01: up to 200 characters.
    check(
      'ck_tasks_title_length',
      sql`char_length(${table.title}) BETWEEN 1 AND 200 AND ${table.title} = btrim(${table.title})`,
    ),
    check('ck_tasks_notes_length', sql`char_length(${table.notes}) <= 10000`),
    check(
      'ck_tasks_reminder',
      sql`(${table.reminderDate} IS NULL) = (${table.reminderMin} IS NULL)
        AND (${table.reminderMin} IS NULL OR ${table.reminderMin} BETWEEN 0 AND 1439)`,
    ),
    // TSK-04: the completion time is recorded, and only while done.
    check(
      'ck_tasks_done_at',
      sql`${table.done} = (${table.doneAt} IS NOT NULL)`,
    ),
    check('ck_tasks_carry_count', sql`${table.carryCount} >= 0`),
  ],
);

export type TaskRow = typeof tasks.$inferSelect;

/**
 * What each closed day recorded about a task (the ledger, `docs/api-plan.md`
 * §1): completed, incomplete (carried over) or missed. The dashboard counts
 * these rows.
 *
 * No `updated_at`, `version` or `idempotency_key`: rows are inserted and
 * deleted, never edited, and only ever as part of a task write.
 */
export const taskLedgerEntries = pgTable(
  'task_ledger_entries',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    userId: uuid('user_id').notNull(),
    // Null once the task is deleted: the day's record stays in the history,
    // as it does in the app, which is why `title` is copied here.
    taskId: uuid('task_id'),
    day: date('day', { mode: 'string' }).notNull(),
    outcome: text('outcome', { enum: TASK_LEDGER_OUTCOMES }).notNull(),
    title: text('title').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Cascade: decision 18 — DELETE /me stays a single delete.
    foreignKey({
      name: 'fk_task_ledger_entries_user_id',
      columns: [table.userId],
      foreignColumns: [users.id],
    }).onDelete('cascade'),
    // Set null: deleting a task keeps what its past days recorded.
    foreignKey({
      name: 'fk_task_ledger_entries_task_id',
      columns: [table.taskId],
      foreignColumns: [tasks.id],
    }).onDelete('set null'),
    // A task records one outcome per day. It leads with `task_id`, so it is
    // also that foreign key's index (schema-conventions §6).
    uniqueIndex('uq_task_ledger_entries_task_id_day').on(
      table.taskId,
      table.day,
    ),
    // The review reads a user's days; also the `user_id` foreign key's index.
    index('idx_task_ledger_entries_user_id_day').on(table.userId, table.day),
    check(
      'ck_task_ledger_entries_outcome',
      oneOf(sql`${table.outcome}`, TASK_LEDGER_OUTCOMES),
    ),
  ],
);

export type TaskLedgerEntryRow = typeof taskLedgerEntries.$inferSelect;

/**
 * The fill patterns a user can choose for a block name by rerolling in the
 * block slip. The UI's `open` trace is left out: it is how the review draws
 * skipped hours, so a reroll never picks it, though a name can hash to it.
 */
export const CHOSEN_TRACES = [
  'solid',
  'ruled',
  'verticalRuled',
  'grid',
  'stipple',
  'dotted',
  'dashed',
  'checker',
] as const;

export type ChosenTrace = (typeof CHOSEN_TRACES)[number];

/**
 * A trace chosen for a block name (`PUT /block-names/{name}/trace`), which
 * every block of that name is drawn in, past and future. A name with no row
 * is drawn in the trace its name hashes to.
 *
 * No `version` or `idempotency_key`: a PUT sets an absolute value, so the last
 * write wins and a retry is harmless.
 */
export const blockNameTraces = pgTable(
  'block_name_traces',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    userId: uuid('user_id').notNull(),
    // The name trimmed and lower-cased (BLK-02): "Family" and " family " are
    // one name.
    nameKey: text('name_key').notNull(),
    trace: text('trace', { enum: CHOSEN_TRACES }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Cascade: decision 18 — DELETE /me stays a single delete.
    foreignKey({
      name: 'fk_block_name_traces_user_id',
      columns: [table.userId],
      foreignColumns: [users.id],
    }).onDelete('cascade'),
    // One choice per name. It leads with `user_id`, so it is also that
    // foreign key's index (schema-conventions §6).
    uniqueIndex('uq_block_name_traces_user_id_name_key').on(
      table.userId,
      table.nameKey,
    ),
    // The same bounds as a block's name. Lower-casing is the application's
    // job: SQL's `lower()` and JavaScript's disagree on a few characters.
    check(
      'ck_block_name_traces_name_key_length',
      sql`char_length(${table.nameKey}) BETWEEN 1 AND 60 AND ${table.nameKey} = btrim(${table.nameKey})`,
    ),
    check(
      'ck_block_name_traces_trace',
      oneOf(sql`${table.trace}`, CHOSEN_TRACES),
    ),
  ],
);

export type BlockNameTraceRow = typeof blockNameTraces.$inferSelect;
