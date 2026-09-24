-- Editing one block occurrence (PATCH /blocks/{seriesId}/occurrences/{date}
-- with scope=onlyThis, api-plan §4): the fields it can override, each null
-- where the occurrence follows its series.
--
-- Nullable columns with no default are metadata-only. The checks scan the
-- table to validate, under its lock; it is young and small, and every new
-- column is null, so that is brief.

ALTER TABLE "block_occurrence_exceptions" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "block_occurrence_exceptions" ADD COLUMN "start_min" smallint;--> statement-breakpoint
ALTER TABLE "block_occurrence_exceptions" ADD COLUMN "end_min" smallint;--> statement-breakpoint
ALTER TABLE "block_occurrence_exceptions" ADD COLUMN "alert" boolean;--> statement-breakpoint
ALTER TABLE "block_occurrence_exceptions" ADD CONSTRAINT "ck_block_occurrence_exceptions_name_length" CHECK ("block_occurrence_exceptions"."name" IS NULL OR (char_length("block_occurrence_exceptions"."name") BETWEEN 1 AND 60 AND "block_occurrence_exceptions"."name" = btrim("block_occurrence_exceptions"."name")));--> statement-breakpoint
ALTER TABLE "block_occurrence_exceptions" ADD CONSTRAINT "ck_block_occurrence_exceptions_start_min" CHECK ("block_occurrence_exceptions"."start_min" IS NULL OR "block_occurrence_exceptions"."start_min" BETWEEN 0 AND 1439);--> statement-breakpoint
ALTER TABLE "block_occurrence_exceptions" ADD CONSTRAINT "ck_block_occurrence_exceptions_end_min" CHECK ("block_occurrence_exceptions"."end_min" IS NULL OR "block_occurrence_exceptions"."end_min" BETWEEN 0 AND 1439);