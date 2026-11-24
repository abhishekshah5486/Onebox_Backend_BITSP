CREATE TABLE "llm"."user_models" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"provider_id" text NOT NULL,
	"model_id" text NOT NULL,
	"name" text NOT NULL,
	"credentials" text NOT NULL,
	"key_hint" text,
	"context_tokens" integer,
	"reasoning" boolean DEFAULT false NOT NULL,
	"multimodal" boolean DEFAULT false NOT NULL,
	"dimensions" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "user_models_user_kind_idx" ON "llm"."user_models" USING btree ("user_id","kind");