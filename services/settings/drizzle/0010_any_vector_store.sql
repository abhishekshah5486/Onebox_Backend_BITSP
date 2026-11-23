-- Any vector database, not only Qdrant: its plain settings as JSON, its secrets encrypted as JSON.
ALTER TABLE "settings"."indexing_stores" ADD COLUMN "settings" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
UPDATE "settings"."indexing_stores" SET "settings" = jsonb_build_object('url', "url");--> statement-breakpoint
ALTER TABLE "settings"."indexing_stores" DROP COLUMN "url";--> statement-breakpoint
-- Older rows hold the bare Qdrant key here; the service reads those as {apiKey}.
ALTER TABLE "settings"."indexing_stores" RENAME COLUMN "api_key_encrypted" TO "secrets_encrypted";
