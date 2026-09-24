-- Tasks (POST /tasks, api-plan §5): the tasks table and the ledger that
-- closed days write.
--
-- Column opt-ins, stated per docs/schema-conventions.md §2 step 2:
--
-- tasks                version: yes — edited from more than one device (PATCH
--                      comes with a later slice). deleted_at: no — DELETE
--                      /tasks decides its own history rules, and the ledger
--                      keeps what past days recorded. idempotency_key: yes —
--                      POST /tasks may be retried after a lost response,
--                      scoped to user_id. updated_at: yes, with its trigger.
-- task_ledger_entries  none of them: rows are inserted and deleted as part of
--                      a task write, never edited or retried on their own.
--
-- Hand-written below: trg_tasks_updated_at.

CREATE TABLE "task_ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"task_id" uuid,
	"day" date NOT NULL,
	"outcome" text NOT NULL,
	"title" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_task_ledger_entries_outcome" CHECK ("task_ledger_entries"."outcome" IN ('completed', 'incomplete', 'missed'))
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"block_series_id" uuid,
	"date" date NOT NULL,
	"title" text NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"reminder_date" date,
	"reminder_min" smallint,
	"done" boolean DEFAULT false NOT NULL,
	"done_at" timestamp with time zone,
	"carry_count" integer DEFAULT 0 NOT NULL,
	"missed" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"idempotency_key" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_tasks_title_length" CHECK (char_length("tasks"."title") BETWEEN 1 AND 200 AND "tasks"."title" = btrim("tasks"."title")),
	CONSTRAINT "ck_tasks_notes_length" CHECK (char_length("tasks"."notes") <= 10000),
	CONSTRAINT "ck_tasks_reminder" CHECK (("tasks"."reminder_date" IS NULL) = ("tasks"."reminder_min" IS NULL)
        AND ("tasks"."reminder_min" IS NULL OR "tasks"."reminder_min" BETWEEN 0 AND 1439)),
	CONSTRAINT "ck_tasks_done_at" CHECK ("tasks"."done" = ("tasks"."done_at" IS NOT NULL)),
	CONSTRAINT "ck_tasks_carry_count" CHECK ("tasks"."carry_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "task_ledger_entries" ADD CONSTRAINT "fk_task_ledger_entries_user_id" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_ledger_entries" ADD CONSTRAINT "fk_task_ledger_entries_task_id" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "fk_tasks_user_id" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "fk_tasks_block_series_id" FOREIGN KEY ("block_series_id") REFERENCES "public"."block_series"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_task_ledger_entries_task_id_day" ON "task_ledger_entries" USING btree ("task_id","day");--> statement-breakpoint
CREATE INDEX "idx_task_ledger_entries_user_id_day" ON "task_ledger_entries" USING btree ("user_id","day");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_tasks_user_id_idempotency_key" ON "tasks" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "idx_tasks_user_id_date" ON "tasks" USING btree ("user_id","date");--> statement-breakpoint
CREATE INDEX "idx_tasks_block_series_id" ON "tasks" USING btree ("block_series_id");--> statement-breakpoint
CREATE TRIGGER trg_tasks_updated_at
  BEFORE UPDATE ON tasks
  FOR EACH ROW
  WHEN (OLD.* IS DISTINCT FROM NEW.*)
  EXECUTE FUNCTION set_updated_at();
