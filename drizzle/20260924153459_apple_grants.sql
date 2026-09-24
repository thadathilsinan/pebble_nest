-- Sign in with Apple (POST /auth/apple, api-plan §2): the apple_grants table.
--
-- Column opt-ins, stated per docs/schema-conventions.md §2 step 2:
--
-- apple_grants  version: no — written only by the server's upsert on sign-in,
--               never a client's read-modify-write. deleted_at: no — the row
--               goes with its account, and nothing about it is history.
--               idempotency_key: no — a retried sign-in replaces the row.
--               updated_at: yes, with its trigger.
--
-- Hand-written below: trg_apple_grants_updated_at.

CREATE TABLE "apple_grants" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"client_id" text NOT NULL,
	"refresh_token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "apple_grants" ADD CONSTRAINT "fk_apple_grants_user_id" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_apple_grants_user_id" ON "apple_grants" USING btree ("user_id");--> statement-breakpoint
CREATE TRIGGER trg_apple_grants_updated_at
  BEFORE UPDATE ON apple_grants
  FOR EACH ROW
  WHEN (OLD.* IS DISTINCT FROM NEW.*)
  EXECUTE FUNCTION set_updated_at();
