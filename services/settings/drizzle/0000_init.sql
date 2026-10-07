CREATE SCHEMA "settings";
--> statement-breakpoint
CREATE TYPE "settings"."autonomy_mode" AS ENUM('MANUAL', 'SUGGEST', 'SEMI', 'AUTO');--> statement-breakpoint
CREATE TYPE "settings"."integration_type" AS ENUM('SLACK', 'WEBHOOK');--> statement-breakpoint
CREATE TABLE "settings"."integrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" "settings"."integration_type" NOT NULL,
	"name" text NOT NULL,
	"config_encrypted" text NOT NULL,
	"target_hint" text NOT NULL,
	"events" text[] NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_tested_at" timestamp with time zone,
	"last_test_ok" boolean,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integrations_user_name_unique" UNIQUE("user_id","name")
);
--> statement-breakpoint
CREATE TABLE "settings"."user_preferences" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"mark_seen_on_fetch" boolean DEFAULT true NOT NULL,
	"autonomy_mode" "settings"."autonomy_mode" DEFAULT 'MANUAL' NOT NULL,
	"signature" text,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "integrations_user_idx" ON "settings"."integrations" USING btree ("user_id");