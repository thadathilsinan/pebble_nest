-- Email sign-in (ACC-01/02/03): the first tables.
--
-- Column opt-ins, stated per docs/schema-conventions.md §2 step 2:
--
-- users                version: yes — PATCH /me edits the profile from several
--                      devices (§10). deleted_at: no — ACC-06 is an immediate
--                      hard delete. idempotency_key: no — rows are created by
--                      sign-in, which is keyed on email already.
-- email_sign_in_codes  version: no — writes are single atomic statements or run
--                      under SELECT … FOR UPDATE. deleted_at: no — a used code is
--                      killed by pulling expires_at back, which keeps the send
--                      counters for the rate limit. idempotency_key: no.
-- sessions             version: no — no read-modify-write edits a session yet;
--                      rotation will be conditional on the token hash.
--                      deleted_at: no — sign-out deletes. idempotency_key: no.
--
-- Nullable columns, each with its reason: users.name (optional, never asked
-- for — api-plan decision 10), users.time_zone (unknown until the client
-- reports it).
--
-- Hand-written below the generated DDL: the three `updated_at` triggers, which
-- the snapshot cannot see. Enumerate them with the query in the escape-hatch
-- register in docs/database-decisions.md.

CREATE TABLE "email_sign_in_codes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"email" text NOT NULL,
	"code_hash" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_sent_at" timestamp with time zone NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL,
	"sends_in_window" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_email_sign_in_codes_email_lowercase" CHECK ("email_sign_in_codes"."email" = lower("email_sign_in_codes"."email")),
	CONSTRAINT "ck_email_sign_in_codes_attempts_non_negative" CHECK ("email_sign_in_codes"."attempts" >= 0),
	CONSTRAINT "ck_email_sign_in_codes_sends_positive" CHECK ("email_sign_in_codes"."sends_in_window" > 0)
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"sign_in_method" text NOT NULL,
	"refresh_token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_sessions_sign_in_method" CHECK ("sessions"."sign_in_method" IN ('google', 'apple', 'email'))
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"week_start" text DEFAULT 'monday' NOT NULL,
	"time_format" text DEFAULT 'system' NOT NULL,
	"time_zone" text,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_users_email_lowercase" CHECK ("users"."email" = lower("users"."email")),
	CONSTRAINT "ck_users_week_start" CHECK ("users"."week_start" IN ('monday', 'sunday')),
	CONSTRAINT "ck_users_time_format" CHECK ("users"."time_format" IN ('system', 'h24', 'h12'))
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "fk_sessions_user_id" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_email_sign_in_codes_email" ON "email_sign_in_codes" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_sessions_refresh_token_hash" ON "sessions" USING btree ("refresh_token_hash");--> statement-breakpoint
CREATE INDEX "idx_sessions_user_id" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_users_email" ON "users" USING btree ("email");

--> statement-breakpoint
CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW
  WHEN (OLD.* IS DISTINCT FROM NEW.*)
  EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_email_sign_in_codes_updated_at
  BEFORE UPDATE ON email_sign_in_codes
  FOR EACH ROW
  WHEN (OLD.* IS DISTINCT FROM NEW.*)
  EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_sessions_updated_at
  BEFORE UPDATE ON sessions
  FOR EACH ROW
  WHEN (OLD.* IS DISTINCT FROM NEW.*)
  EXECUTE FUNCTION set_updated_at();
