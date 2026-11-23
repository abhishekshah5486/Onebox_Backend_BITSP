CREATE SCHEMA "billing";
--> statement-breakpoint
CREATE TYPE "billing"."account_status" AS ENUM('free', 'active', 'past_due', 'halted');--> statement-breakpoint
CREATE TYPE "billing"."billing_interval" AS ENUM('monthly', 'annual');--> statement-breakpoint
CREATE TYPE "billing"."ledger_kind" AS ENUM('grant', 'charge', 'refund', 'expiry');--> statement-breakpoint
CREATE TYPE "billing"."plan" AS ENUM('FREE', 'STANDARD', 'PRO');--> statement-breakpoint
CREATE TABLE "billing"."accounts" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"plan" "billing"."plan" DEFAULT 'FREE' NOT NULL,
	"interval" "billing"."billing_interval",
	"status" "billing"."account_status" DEFAULT 'free' NOT NULL,
	"subscription_id" uuid,
	"period_end" timestamp with time zone,
	"next_refill_at" timestamp with time zone,
	"balance" numeric(12, 2) DEFAULT 0 NOT NULL,
	"period_credits" numeric(12, 2) DEFAULT 0 NOT NULL,
	"bonus_given" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing"."ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" "billing"."ledger_kind" NOT NULL,
	"credits" numeric(12, 2) DEFAULT 0 NOT NULL,
	"balance_after" numeric(12, 2) DEFAULT 0 NOT NULL,
	"description" text NOT NULL,
	"model" text,
	"source_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "ledger_source_key_unique" UNIQUE("source_key")
);
--> statement-breakpoint
CREATE TABLE "billing"."processed_events" (
	"job_id" text PRIMARY KEY NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "ledger_user_created_idx" ON "billing"."ledger" USING btree ("user_id","created_at");