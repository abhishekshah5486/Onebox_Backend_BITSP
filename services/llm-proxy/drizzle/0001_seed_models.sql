-- The models users can choose from, best first within each provider.
INSERT INTO "llm"."models" ("id", "provider", "name", "description", "rank") VALUES
  ('gpt-6-astra', 'OPENAI', 'GPT-6 Astra', 'OpenAI''s most powerful model', 1),
  ('gpt-6.1-sol', 'OPENAI', 'GPT-6.1 Sol', 'OpenAI''s latest all-rounder', 2),
  ('gpt-6-sol', 'OPENAI', 'GPT-6 Sol', 'Strong reasoning at a lower cost', 3),
  ('gpt-6-luna', 'OPENAI', 'GPT-6 Luna', 'Fast and capable', 4),
  ('gpt-5.6-terra', 'OPENAI', 'GPT-5.6 Terra', 'Reliable previous generation', 5),
  ('gpt-5.4-mini', 'OPENAI', 'GPT-5.4 mini', 'Quick and economical', 6),
  ('gemini-3.1-pro-preview', 'GEMINI', 'Gemini 3.1 Pro', 'Google''s most intelligent model', 1),
  ('gemini-3.8-flash', 'GEMINI', 'Gemini 3.8 Flash', 'Google''s latest fast model', 2),
  ('gemini-3.7-flash', 'GEMINI', 'Gemini 3.7 Flash', 'Fast with strong quality', 3),
  ('gemini-3.5-flash', 'GEMINI', 'Gemini 3.5 Flash', 'Balanced speed and quality', 4),
  ('gemini-3.5-flash-lite', 'GEMINI', 'Gemini 3.5 Flash-Lite', 'Lightest and quickest', 5),
  ('gemini-2.5-flash', 'GEMINI', 'Gemini 2.5 Flash', 'Proven earlier generation', 6),
  ('claude-fable-5-1', 'ANTHROPIC', 'Claude Fable 5.1', 'Anthropic''s most intelligent model', 1),
  ('claude-opus-5-5', 'ANTHROPIC', 'Claude Opus 5.5', 'Anthropic''s high-intelligence model', 2),
  ('claude-sonnet-5-5', 'ANTHROPIC', 'Claude Sonnet 5.5', 'Balanced intelligence and speed', 3),
  ('claude-haiku-4-5-20251001', 'ANTHROPIC', 'Claude Haiku 4.5', 'Anthropic''s fastest model', 4);
--> statement-breakpoint
-- "Auto" per purpose: quick models for sorting mail, stronger ones for writing.
INSERT INTO "llm"."purpose_routes" ("purpose", "position", "model_id") VALUES
  ('classify', 1, 'gemini-3.8-flash'),
  ('classify', 2, 'gpt-6-luna'),
  ('classify', 3, 'gemini-3.5-flash'),
  ('classify', 4, 'gpt-5.4-mini'),
  ('extract', 1, 'gemini-3.8-flash'),
  ('extract', 2, 'gpt-6-luna'),
  ('extract', 3, 'gemini-3.5-flash'),
  ('summarize', 1, 'gemini-3.8-flash'),
  ('summarize', 2, 'gpt-6-luna'),
  ('draft', 1, 'gpt-6.1-sol'),
  ('draft', 2, 'gemini-3.1-pro-preview'),
  ('draft', 3, 'gpt-6-luna');
