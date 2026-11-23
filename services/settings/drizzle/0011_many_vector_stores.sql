CREATE TABLE "settings"."indexing_preferences" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"search_store_id" text DEFAULT 'onebox' NOT NULL,
	"onebox_paused" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- A user may now keep several stores, so each gets its own id.
ALTER TABLE "settings"."indexing_stores" DROP CONSTRAINT "indexing_stores_pkey";--> statement-breakpoint
ALTER TABLE "settings"."indexing_stores" ADD COLUMN "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "settings"."indexing_stores" ADD COLUMN "name" text;--> statement-breakpoint
UPDATE "settings"."indexing_stores" SET "name" = initcap(replace(lower("provider"), '_', ' '));--> statement-breakpoint
ALTER TABLE "settings"."indexing_stores" ALTER COLUMN "name" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "settings"."indexing_stores" ADD COLUMN "paused" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "indexing_stores_user_idx" ON "settings"."indexing_stores" USING btree ("user_id");--> statement-breakpoint
-- Before, a user's own store was the one searches used.
INSERT INTO "settings"."indexing_preferences" ("user_id", "search_store_id")
SELECT "user_id", "id"::text FROM "settings"."indexing_stores";
