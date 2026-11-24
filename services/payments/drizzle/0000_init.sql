CREATE SCHEMA "payments";
--> statement-breakpoint
CREATE TYPE "payments"."billing_interval" AS ENUM('monthly', 'annual');--> statement-breakpoint
CREATE TYPE "payments"."payment_status" AS ENUM('captured', 'failed', 'refunded');--> statement-breakpoint
CREATE TYPE "payments"."plan" AS ENUM('FREE', 'STANDARD', 'PRO');--> statement-breakpoint
CREATE TYPE "payments"."provider" AS ENUM('RAZORPAY', 'STRIPE');--> statement-breakpoint
CREATE TYPE "payments"."subscription_status" AS ENUM('created', 'authenticated', 'active', 'pending', 'halted', 'cancelled', 'completed', 'expired');--> statement-breakpoint
CREATE TABLE "payments"."customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" "payments"."provider" NOT NULL,
	"provider_customer_id" text NOT NULL,
	"email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customers_user_provider_unique" UNIQUE("user_id","provider")
);
--> statement-breakpoint
CREATE TABLE "payments"."payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" "payments"."provider" NOT NULL,
	"provider_payment_id" text NOT NULL,
	"subscription_id" uuid,
	"amount" integer NOT NULL,
	"currency" text NOT NULL,
	"status" "payments"."payment_status" NOT NULL,
	"method" text,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_provider_payment_id_unique" UNIQUE("provider_payment_id")
);
--> statement-breakpoint
CREATE TABLE "payments"."provider_plans" (
	"provider" "payments"."provider" NOT NULL,
	"plan" "payments"."plan" NOT NULL,
	"interval" "payments"."billing_interval" NOT NULL,
	"amount" integer NOT NULL,
	"currency" text NOT NULL,
	"provider_plan_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_plans_unique" UNIQUE("provider","plan","interval","amount","currency")
);
--> statement-breakpoint
CREATE TABLE "payments"."subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" "payments"."provider" NOT NULL,
	"provider_subscription_id" text NOT NULL,
	"plan" "payments"."plan" NOT NULL,
	"interval" "payments"."billing_interval" NOT NULL,
	"status" "payments"."subscription_status" DEFAULT 'created' NOT NULL,
	"current_period_start" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscriptions_provider_subscription_id_unique" UNIQUE("provider_subscription_id")
);
--> statement-breakpoint
CREATE TABLE "payments"."webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" "payments"."provider" NOT NULL,
	"event_id" text NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"error" text,
	CONSTRAINT "webhook_events_unique" UNIQUE("provider","event_id")
);
--> statement-breakpoint
ALTER TABLE "payments"."payments" ADD CONSTRAINT "payments_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "payments"."subscriptions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payments_user_idx" ON "payments"."payments" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "subscriptions_user_idx" ON "payments"."subscriptions" USING btree ("user_id");