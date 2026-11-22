CREATE TABLE "llm"."provider_catalog" (
	"source" text PRIMARY KEY NOT NULL,
	"body" jsonb NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL
);
