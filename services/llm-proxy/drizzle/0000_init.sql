CREATE SCHEMA "llm";
--> statement-breakpoint
CREATE TYPE "llm"."provider" AS ENUM('OPENAI', 'GEMINI', 'ANTHROPIC');--> statement-breakpoint
CREATE TABLE "llm"."llm_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"subject" text,
	"trace_id" text,
	"requested_model" text NOT NULL,
	"model_used" text,
	"provider" "llm"."provider",
	"status" text NOT NULL,
	"error_code" text,
	"cache_hit" boolean DEFAULT false NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"latency_ms" integer NOT NULL,
	"attempts" jsonb NOT NULL,
	"request_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "llm"."models" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" "llm"."provider" NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"rank" integer NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "llm"."purpose_routes" (
	"purpose" text NOT NULL,
	"position" integer NOT NULL,
	"model_id" text NOT NULL,
	CONSTRAINT "purpose_routes_purpose_position_pk" PRIMARY KEY("purpose","position")
);
--> statement-breakpoint
CREATE TABLE "llm"."user_model_choices" (
	"user_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"model_id" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_model_choices_user_id_purpose_pk" PRIMARY KEY("user_id","purpose")
);
--> statement-breakpoint
ALTER TABLE "llm"."purpose_routes" ADD CONSTRAINT "purpose_routes_model_id_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "llm"."models"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm"."user_model_choices" ADD CONSTRAINT "user_model_choices_model_id_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "llm"."models"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "llm_calls_user_created_idx" ON "llm"."llm_calls" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "llm_calls_created_idx" ON "llm"."llm_calls" USING btree ("created_at");