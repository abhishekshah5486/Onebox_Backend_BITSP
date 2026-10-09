-- Several Google accounts per user, each with its own default folder.
ALTER TABLE "settings"."google_connections" DROP CONSTRAINT "google_connections_pkey";--> statement-breakpoint
ALTER TABLE "settings"."google_connections" ADD COLUMN "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "settings"."google_connections" ADD COLUMN "default_path" text DEFAULT '' NOT NULL;--> statement-breakpoint
-- Accounts connected before this kept their files in the OneBox folder.
UPDATE "settings"."google_connections" SET "default_path" = 'OneBox';--> statement-breakpoint
ALTER TABLE "settings"."google_connections" ADD CONSTRAINT "google_connections_user_email_unique" UNIQUE("user_id","email");
