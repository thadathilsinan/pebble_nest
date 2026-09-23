-- Refresh-token rotation (/auth/refresh, api-plan §2): the tokens each session
-- has rotated away from, so reuse of one revokes the session.
--
-- Column opt-ins, stated per docs/schema-conventions.md §2 step 2:
--
-- session_refresh_tokens  version: no — insert-only. deleted_at: no — rows go
--                         with their session (cascade). idempotency_key: no —
--                         written only inside a refresh, under the session's
--                         row lock. updated_at: no — never updated, so no
--                         trigger either.
--
-- Nothing hand-written: every object below is in the snapshot.

CREATE TABLE "session_refresh_tokens" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"session_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"retired_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "session_refresh_tokens" ADD CONSTRAINT "fk_session_refresh_tokens_session_id" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_session_refresh_tokens_token_hash" ON "session_refresh_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "idx_session_refresh_tokens_session_id_retired_at" ON "session_refresh_tokens" USING btree ("session_id","retired_at");