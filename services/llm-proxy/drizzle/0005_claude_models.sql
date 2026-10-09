-- Every Claude model from Opus 4.5 to Opus 5.5. Prices are USD per million tokens (input, output,
-- cache read, 5-minute cache write) from Anthropic's price list.
INSERT INTO "llm"."models" ("id", "provider", "name", "description", "rank", "input_price", "output_price", "cache_read_price", "cache_write_price") VALUES
  ('claude-fable-5', 'ANTHROPIC', 'Claude Fable 5', 'Previous most intelligent model', 4, 10, 50, 1, 12.5),
  ('claude-opus-5', 'ANTHROPIC', 'Claude Opus 5', 'High intelligence, previous generation', 5, 5, 25, 0.5, 6.25),
  ('claude-sonnet-5', 'ANTHROPIC', 'Claude Sonnet 5', 'Balanced, previous generation', 6, 2, 10, 0.2, 2.5),
  ('claude-opus-4-8', 'ANTHROPIC', 'Claude Opus 4.8', 'Strong reasoning and writing', 7, 5, 25, 0.5, 6.25),
  ('claude-opus-4-7', 'ANTHROPIC', 'Claude Opus 4.7', 'Strong reasoning and writing', 8, 5, 25, 0.5, 6.25),
  ('claude-opus-4-6', 'ANTHROPIC', 'Claude Opus 4.6', 'Strong reasoning and writing', 9, 5, 25, 0.5, 6.25),
  ('claude-sonnet-4-6', 'ANTHROPIC', 'Claude Sonnet 4.6', 'Reliable all-rounder', 10, 3, 15, 0.3, 3.75),
  ('claude-opus-4-5-20251101', 'ANTHROPIC', 'Claude Opus 4.5', 'Earliest Opus 4 generation model offered', 11, 5, 25, 0.5, 6.25);
--> statement-breakpoint
-- Newest first, so a failing model falls back to the next newest; Haiku stays the quick last resort.
UPDATE "llm"."models" SET "rank" = 12 WHERE "id" = 'claude-haiku-4-5-20251001';
