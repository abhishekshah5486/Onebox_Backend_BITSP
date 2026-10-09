CREATE SCHEMA "accounts";
--> statement-breakpoint
CREATE TYPE "accounts"."account_status" AS ENUM('CONNECTED', 'AUTH_FAILED', 'UNREACHABLE', 'DISABLED');--> statement-breakpoint
CREATE TYPE "accounts"."provider" AS ENUM('GMAIL', 'OUTLOOK', 'IMAP');--> statement-breakpoint
CREATE TABLE "accounts"."email_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" "accounts"."provider" NOT NULL,
	"email_address" text NOT NULL,
	"display_name" text,
	"imap_host" text NOT NULL,
	"imap_port" integer NOT NULL,
	"imap_tls" boolean NOT NULL,
	"smtp_host" text,
	"smtp_port" integer,
	"smtp_tls" boolean,
	"username" text NOT NULL,
	"credentials_encrypted" text NOT NULL,
	"status" "accounts"."account_status" DEFAULT 'CONNECTED' NOT NULL,
	"last_error" text,
	"last_verified_at" timestamp with time zone,
	"sync_state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_accounts_user_email_unique" UNIQUE("user_id","email_address")
);
--> statement-breakpoint
CREATE INDEX "email_accounts_user_idx" ON "accounts"."email_accounts" USING btree ("user_id");