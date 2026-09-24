-- Skipping a block occurrence (POST/DELETE /blocks/{seriesId}/occurrences/
-- {date}/skip, api-plan §4): the block_occurrence_exceptions table.
--
-- Column opt-ins, stated per docs/schema-conventions.md §2 step 2:
--
-- block_occurrence_exceptions  version: no — skipping sets an absolute value,
--                              so the last write wins. deleted_at: no —
--                              un-skipping deletes the row; nothing about it
--                              is history. idempotency_key: no — skip and
--                              un-skip are idempotent on their own.
--                              updated_at: yes, with its trigger, since later
--                              slices edit a row in place.
--
-- Hand-written below: trg_block_occurrence_exceptions_updated_at.

CREATE TABLE "block_occurrence_exceptions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"block_series_id" uuid NOT NULL,
	"date" date NOT NULL,
	"skipped" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "block_occurrence_exceptions" ADD CONSTRAINT "fk_block_occurrence_exceptions_user_id" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "block_occurrence_exceptions" ADD CONSTRAINT "fk_block_occurrence_exceptions_block_series_id" FOREIGN KEY ("block_series_id") REFERENCES "public"."block_series"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_block_occurrence_exceptions_block_series_id_date" ON "block_occurrence_exceptions" USING btree ("block_series_id","date");--> statement-breakpoint
CREATE INDEX "idx_block_occurrence_exceptions_user_id_date" ON "block_occurrence_exceptions" USING btree ("user_id","date");--> statement-breakpoint
CREATE TRIGGER trg_block_occurrence_exceptions_updated_at
  BEFORE UPDATE ON block_occurrence_exceptions
  FOR EACH ROW
  WHEN (OLD.* IS DISTINCT FROM NEW.*)
  EXECUTE FUNCTION set_updated_at();
