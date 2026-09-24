-- Repeating tasks (api-plan §5, the task series slice): the task_series
-- table, the dates each series has issued, and tasks.task_series_id.
--
-- Column opt-ins, stated per docs/schema-conventions.md §2 step 2:
--
-- task_series               version: no — a series is edited through one of
--                           its tasks, whose version is checked, with the
--                           series row locked after the task's.
--                           deleted_at: no — ending a series sets ended_on;
--                           deleting one keeps its tasks as one-offs.
--                           idempotency_key: no — created inside POST
--                           /tasks, which has its own. updated_at: yes, with
--                           its trigger.
-- task_series_issued_dates  none of them, and no id: a set of (series, date)
--                           pairs, only ever inserted, whose composite
--                           primary key is what makes issuing a date happen
--                           once. Nothing addresses a row by id.
--
-- Hand-written below: trg_task_series_updated_at.

CREATE TABLE "task_series" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"block_series_id" uuid,
	"anchor_date" date NOT NULL,
	"ended_on" date,
	"recurrence_kind" text DEFAULT 'none' NOT NULL,
	"weekdays" smallint[] DEFAULT '{}' NOT NULL,
	"month_days" smallint[] DEFAULT '{}' NOT NULL,
	"until" date,
	"title" text NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"reminder_day_offset" integer,
	"reminder_min" smallint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_task_series_repeat_mode" CHECK (("task_series"."block_series_id" IS NULL) = ("task_series"."recurrence_kind" <> 'none')),
	CONSTRAINT "ck_task_series_recurrence_kind" CHECK ("task_series"."recurrence_kind" IN ('none', 'daily', 'weekly', 'monthly')),
	CONSTRAINT "ck_task_series_weekdays" CHECK (CASE WHEN "task_series"."recurrence_kind" = 'weekly'
        THEN cardinality("task_series"."weekdays") > 0 AND "task_series"."weekdays" <@ '{1,2,3,4,5,6,7}'::smallint[]
        ELSE cardinality("task_series"."weekdays") = 0 END),
	CONSTRAINT "ck_task_series_month_days" CHECK (CASE WHEN "task_series"."recurrence_kind" = 'monthly'
        THEN cardinality("task_series"."month_days") > 0 AND 1 <= ALL("task_series"."month_days") AND 31 >= ALL("task_series"."month_days")
        ELSE cardinality("task_series"."month_days") = 0 END),
	CONSTRAINT "ck_task_series_until" CHECK ("task_series"."until" IS NULL OR ("task_series"."recurrence_kind" <> 'none' AND "task_series"."until" >= "task_series"."anchor_date")),
	CONSTRAINT "ck_task_series_ended_on" CHECK ("task_series"."ended_on" IS NULL OR "task_series"."ended_on" >= "task_series"."anchor_date"),
	CONSTRAINT "ck_task_series_title_length" CHECK (char_length("task_series"."title") BETWEEN 1 AND 200 AND "task_series"."title" = btrim("task_series"."title")),
	CONSTRAINT "ck_task_series_notes_length" CHECK (char_length("task_series"."notes") <= 10000),
	CONSTRAINT "ck_task_series_reminder" CHECK (("task_series"."reminder_day_offset" IS NULL) = ("task_series"."reminder_min" IS NULL)
        AND ("task_series"."reminder_min" IS NULL OR "task_series"."reminder_min" BETWEEN 0 AND 1439))
);
--> statement-breakpoint
CREATE TABLE "task_series_issued_dates" (
	"task_series_id" uuid NOT NULL,
	"date" date NOT NULL,
	CONSTRAINT "pk_task_series_issued_dates" PRIMARY KEY("task_series_id","date")
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "task_series_id" uuid;--> statement-breakpoint
ALTER TABLE "task_series" ADD CONSTRAINT "fk_task_series_user_id" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_series" ADD CONSTRAINT "fk_task_series_block_series_id" FOREIGN KEY ("block_series_id") REFERENCES "public"."block_series"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_series_issued_dates" ADD CONSTRAINT "fk_task_series_issued_dates_task_series_id" FOREIGN KEY ("task_series_id") REFERENCES "public"."task_series"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_task_series_user_id" ON "task_series" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_task_series_block_series_id" ON "task_series" USING btree ("block_series_id");--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "fk_tasks_task_series_id" FOREIGN KEY ("task_series_id") REFERENCES "public"."task_series"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_tasks_task_series_id" ON "tasks" USING btree ("task_series_id");--> statement-breakpoint
CREATE TRIGGER trg_task_series_updated_at
  BEFORE UPDATE ON task_series
  FOR EACH ROW
  WHEN (OLD.* IS DISTINCT FROM NEW.*)
  EXECUTE FUNCTION set_updated_at();
