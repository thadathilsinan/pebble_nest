-- Block names (GET /block-names, PUT /block-names/{name}/trace, api-plan §4):
-- the block_name_traces table.
--
-- Column opt-ins, stated per docs/schema-conventions.md §2 step 2:
--
-- block_name_traces  version: no — a PUT sets an absolute value, so the last
--                    write wins. deleted_at: no — clearing a choice deletes
--                    its row; nothing about it is history. idempotency_key:
--                    no — PUT is idempotent on its own. updated_at: yes, with
--                    its trigger.
--
-- Hand-written below: trg_block_name_traces_updated_at.

CREATE TABLE "block_name_traces" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"name_key" text NOT NULL,
	"trace" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_block_name_traces_name_key_length" CHECK (char_length("block_name_traces"."name_key") BETWEEN 1 AND 60 AND "block_name_traces"."name_key" = btrim("block_name_traces"."name_key")),
	CONSTRAINT "ck_block_name_traces_trace" CHECK ("block_name_traces"."trace" IN ('solid', 'ruled', 'verticalRuled', 'grid', 'stipple', 'dotted', 'dashed', 'checker'))
);
--> statement-breakpoint
ALTER TABLE "block_name_traces" ADD CONSTRAINT "fk_block_name_traces_user_id" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_block_name_traces_user_id_name_key" ON "block_name_traces" USING btree ("user_id","name_key");--> statement-breakpoint
CREATE TRIGGER trg_block_name_traces_updated_at
  BEFORE UPDATE ON block_name_traces
  FOR EACH ROW
  WHEN (OLD.* IS DISTINCT FROM NEW.*)
  EXECUTE FUNCTION set_updated_at();
