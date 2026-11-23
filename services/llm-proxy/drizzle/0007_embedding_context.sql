ALTER TABLE "llm"."embedding_models" ADD COLUMN "context_tokens" integer;--> statement-breakpoint
-- Input limits from each provider's model documentation.
UPDATE "llm"."embedding_models" SET "context_tokens" = 8191 WHERE "provider" = 'OPENAI';
--> statement-breakpoint
UPDATE "llm"."embedding_models" SET "context_tokens" = 2048 WHERE "id" = 'gemini/gemini-embedding-001';
