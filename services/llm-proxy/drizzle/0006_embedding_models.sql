CREATE TABLE "llm"."embedding_models" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" "llm"."provider" NOT NULL,
	"api_name" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"dimensions" integer NOT NULL,
	"send_dimensions" boolean DEFAULT false NOT NULL,
	"price" numeric DEFAULT 0 NOT NULL,
	"rank" integer NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "llm"."user_embedding_choices" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"model_id" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Hosted embedding models, prices in USD per million tokens from each provider's price list.
-- Large models are shortened (Matryoshka) to keep Qdrant small at nearly the same quality.
INSERT INTO "llm"."embedding_models" ("id", "provider", "api_name", "name", "description", "dimensions", "send_dimensions", "price", "rank") VALUES
  ('openai/text-embedding-3-small', 'OPENAI', 'text-embedding-3-small', 'OpenAI text-embedding-3-small', 'Fast and cheap, good English search', 1536, false, 0.02, 1),
  ('openai/text-embedding-3-large', 'OPENAI', 'text-embedding-3-large', 'OpenAI text-embedding-3-large', 'OpenAI''s best, shortened to 1,024 dimensions', 1024, true, 0.13, 2),
  ('gemini/gemini-embedding-001', 'GEMINI', 'gemini-embedding-001', 'Gemini embedding 001', 'Google''s multilingual model, shortened to 768 dimensions', 768, true, 0.15, 3);
