ALTER TABLE "settings"."user_preferences" ADD COLUMN "setup_done" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- People who were here before the setup existed have already set up OneBox their way.
UPDATE "settings"."user_preferences" SET "setup_done" = true;
