-- Google connections become cloud storage accounts with a provider.
CREATE TYPE "settings"."storage_provider" AS ENUM('GOOGLE_DRIVE');--> statement-breakpoint
CREATE TABLE "settings"."storage_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" "settings"."storage_provider" NOT NULL,
	"email" text NOT NULL,
	"refresh_token_encrypted" text NOT NULL,
	"scopes" text[] NOT NULL,
	"default_path" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "storage_accounts_user_provider_email_unique" UNIQUE("user_id","provider","email")
);
--> statement-breakpoint
-- Keep the Google accounts already connected.
INSERT INTO "settings"."storage_accounts" ("id", "user_id", "provider", "email", "refresh_token_encrypted", "scopes", "default_path", "created_at", "updated_at")
  SELECT "id", "user_id", 'GOOGLE_DRIVE', "email", "refresh_token_encrypted", "scopes", "default_path", "created_at", "updated_at"
  FROM "settings"."google_connections";--> statement-breakpoint
DROP TABLE "settings"."google_connections" CASCADE;