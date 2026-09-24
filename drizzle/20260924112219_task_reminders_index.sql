-- Task reminders for GET /notifications/schedule (api-plan §6): open tasks by
-- the reminder's own date, which needn't be the task's.
--
-- A plain CREATE INDEX (docs/migrations.md: CONCURRENTLY can't run in the
-- migrator's transaction). It blocks writes to tasks while it builds; the
-- table is young and small, so that is brief.

CREATE INDEX "idx_tasks_user_id_reminder_date" ON "tasks" USING btree ("user_id","reminder_date") WHERE NOT "tasks"."done" AND "tasks"."reminder_date" IS NOT NULL;