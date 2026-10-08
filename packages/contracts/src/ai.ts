import { z } from 'zod';

// mail -> ai: a newly arrived email to sort into the user's labels. Only what the model needs.
export const aiClassifyPayloadSchema = z.object({
  messageId: z.string().min(1),
  threadId: z.string().min(1),
  from: z.string().max(400),
  to: z.string().max(2000),
  subject: z.string().max(1000),
  // Trimmed text without quoted replies; never the raw message.
  body: z.string().max(12_000),
  snippet: z.string().max(300),
  receivedAt: z.iso.datetime(),
});

export type AiClassifyPayload = z.infer<typeof aiClassifyPayloadSchema>;

// How a label takes part in AI sorting.
export const AI_LABEL_MODES = ['auto', 'suggest', 'off'] as const;
export type AiLabelMode = (typeof AI_LABEL_MODES)[number];
