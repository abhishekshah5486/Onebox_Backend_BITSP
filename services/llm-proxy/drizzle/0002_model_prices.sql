ALTER TABLE "llm"."llm_calls" ADD COLUMN "cache_read_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "llm"."llm_calls" ADD COLUMN "cache_write_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "llm"."llm_calls" ADD COLUMN "cost_usd" numeric(14, 8) DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "llm"."models" ADD COLUMN "input_price" numeric DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "llm"."models" ADD COLUMN "output_price" numeric DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "llm"."models" ADD COLUMN "cache_read_price" numeric DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "llm"."models" ADD COLUMN "cache_write_price" numeric DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Standard-tier list prices, USD per million tokens (October 2026). Gemini 3.7/3.8 Flash are on
-- their introductory price until the end of 2026. Writing to OpenAI's and Gemini's implicit
-- caches costs the normal input price.
UPDATE "llm"."models" AS m SET
  "input_price" = p.input, "output_price" = p.output,
  "cache_read_price" = p.cache_read, "cache_write_price" = p.cache_write
FROM (VALUES
  ('gpt-6-astra', 10, 50, 1, 10),
  ('gpt-6.1-sol', 2, 10, 0.1, 2),
  ('gpt-6-sol', 2, 10, 0.2, 2),
  ('gpt-6-luna', 0.1, 0.5, 0.01, 0.1),
  ('gpt-5.6-terra', 2, 12, 0.2, 2),
  ('gpt-5.4-mini', 0.75, 4.5, 0.075, 0.75),
  ('gemini-3.1-pro-preview', 2, 12, 0.2, 2),
  ('gemini-3.8-flash', 0.75, 3.75, 0.075, 0.75),
  ('gemini-3.7-flash', 0.75, 3.75, 0.075, 0.75),
  ('gemini-3.5-flash', 1.5, 9, 0.15, 1.5),
  ('gemini-3.5-flash-lite', 0.3, 2.5, 0.03, 0.3),
  ('gemini-2.5-flash', 0.3, 2.5, 0.03, 0.3),
  ('claude-fable-5-1', 10, 50, 0.25, 12.5),
  ('claude-opus-5-5', 4, 20, 0.2, 5),
  ('claude-sonnet-5-5', 2, 10, 0.1, 2.5),
  ('claude-haiku-4-5-20251001', 1, 5, 0.1, 1.25)
) AS p(id, input, output, cache_read, cache_write)
WHERE m."id" = p.id;
