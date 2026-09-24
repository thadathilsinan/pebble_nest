-- Blocks (POST /blocks, api-plan §4): the block_series table.
--
-- Column opt-ins, stated per docs/schema-conventions.md §2 step 2:
--
-- block_series  version: yes — edited from more than one device (PATCH comes
--               with a later slice). deleted_at: no — DELETE /blocks decides
--               its own history rules (api-plan §4). idempotency_key: yes —
--               POST /blocks may be retried after a lost response, scoped to
--               user_id. updated_at: yes, with its trigger.
--
-- Hand-written below: trg_block_series_updated_at.

CREATE TABLE "block_series" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"anchor_date" date NOT NULL,
	"start_min" smallint NOT NULL,
	"end_min" smallint NOT NULL,
	"recurrence_kind" text DEFAULT 'none' NOT NULL,
	"weekdays" smallint[] DEFAULT '{}' NOT NULL,
	"month_days" smallint[] DEFAULT '{}' NOT NULL,
	"until" date,
	"alert" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"idempotency_key" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_block_series_name_length" CHECK (char_length("block_series"."name") BETWEEN 1 AND 60 AND "block_series"."name" = btrim("block_series"."name")),
	CONSTRAINT "ck_block_series_start_min" CHECK ("block_series"."start_min" BETWEEN 0 AND 1439),
	CONSTRAINT "ck_block_series_end_min" CHECK ("block_series"."end_min" BETWEEN 0 AND 1439),
	CONSTRAINT "ck_block_series_min_length" CHECK (("block_series"."end_min" - "block_series"."start_min" + 1440) % 1440 >= 5 OR "block_series"."end_min" = "block_series"."start_min"),
	CONSTRAINT "ck_block_series_recurrence_kind" CHECK ("block_series"."recurrence_kind" IN ('none', 'daily', 'weekly', 'monthly')),
	CONSTRAINT "ck_block_series_weekdays" CHECK (CASE WHEN "block_series"."recurrence_kind" = 'weekly'
        THEN cardinality("block_series"."weekdays") > 0 AND "block_series"."weekdays" <@ '{1,2,3,4,5,6,7}'::smallint[]
        ELSE cardinality("block_series"."weekdays") = 0 END),
	CONSTRAINT "ck_block_series_month_days" CHECK (CASE WHEN "block_series"."recurrence_kind" = 'monthly'
        THEN cardinality("block_series"."month_days") > 0 AND 1 <= ALL("block_series"."month_days") AND 31 >= ALL("block_series"."month_days")
        ELSE cardinality("block_series"."month_days") = 0 END),
	CONSTRAINT "ck_block_series_until" CHECK ("block_series"."until" IS NULL OR ("block_series"."recurrence_kind" <> 'none' AND "block_series"."until" >= "block_series"."anchor_date"))
);
--> statement-breakpoint
ALTER TABLE "block_series" ADD CONSTRAINT "fk_block_series_user_id" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_block_series_user_id_idempotency_key" ON "block_series" USING btree ("user_id","idempotency_key");
--> statement-breakpoint
CREATE TRIGGER trg_block_series_updated_at
  BEFORE UPDATE ON block_series
  FOR EACH ROW
  WHEN (OLD.* IS DISTINCT FROM NEW.*)
  EXECUTE FUNCTION set_updated_at();
