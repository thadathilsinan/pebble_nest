-- Deleting a block occurrence (DELETE /blocks/{seriesId}/occurrences/{date},
-- api-plan §4): block_occurrence_exceptions.deleted.
--
-- Adding a NOT NULL column with a constant default is a metadata-only change
-- in Postgres, so it takes no table rewrite.

ALTER TABLE "block_occurrence_exceptions" ADD COLUMN "deleted" boolean DEFAULT false NOT NULL;