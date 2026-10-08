-- LLMs no other provider here offers, reached through Perplexity's Agent API. Prices are USD per
-- million tokens from Perplexity's model list; the cost each call reports is what is kept.
INSERT INTO "llm"."models" ("id", "provider", "name", "description", "rank", "input_price", "output_price", "cache_read_price", "cache_write_price") VALUES
  ('xai/grok-4.7', 'PERPLEXITY', 'Grok 4.7', 'xAI''s latest model', 1, 2, 6, 0.5, 2),
  ('perplexity/kimi-k3', 'PERPLEXITY', 'Kimi K3', 'Moonshot AI''s flagship', 2, 3, 15, 0.3, 3),
  ('perplexity/glm-5.3', 'PERPLEXITY', 'GLM 5.3', 'Zhipu AI''s flagship', 3, 1.4, 4.4, 0.26, 1.4),
  ('perplexity/deepseek-v4-pro-0813', 'PERPLEXITY', 'DeepSeek V4 Pro', 'DeepSeek''s reasoning model', 4, 1.32, 3.96, 0.044, 1.32),
  ('perplexity/nemotron-3-ultra-550b-a55b', 'PERPLEXITY', 'Nemotron 3 Ultra', 'NVIDIA''s open model', 5, 0.25, 2.5, 0.25, 0.25),
  ('xai/grok-4.5', 'PERPLEXITY', 'Grok 4.5', 'Strong reasoning from xAI', 6, 2, 6, 0.3, 2),
  ('xai/grok-4.3', 'PERPLEXITY', 'Grok 4.3', 'Fast and economical', 7, 1.25, 2.5, 0.2, 1.25),
  ('perplexity/glm-5.3-flash', 'PERPLEXITY', 'GLM 5.3 Flash', 'Quick and low cost', 8, 0.15, 0.5, 0.03, 0.15);
