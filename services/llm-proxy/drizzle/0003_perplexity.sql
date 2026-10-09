-- Perplexity joins the providers. The enum is rebuilt rather than extended, because migrations run
-- in one transaction and Postgres will not use a value added by ALTER TYPE ... ADD VALUE there.
CREATE TYPE "llm"."provider_v2" AS ENUM('OPENAI', 'GEMINI', 'ANTHROPIC', 'PERPLEXITY');--> statement-breakpoint
ALTER TABLE "llm"."models" ALTER COLUMN "provider" TYPE "llm"."provider_v2" USING "provider"::text::"llm"."provider_v2";--> statement-breakpoint
ALTER TABLE "llm"."llm_calls" ALTER COLUMN "provider" TYPE "llm"."provider_v2" USING "provider"::text::"llm"."provider_v2";--> statement-breakpoint
DROP TYPE "llm"."provider";--> statement-breakpoint
ALTER TYPE "llm"."provider_v2" RENAME TO "provider";
