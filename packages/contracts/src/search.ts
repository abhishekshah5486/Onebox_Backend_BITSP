import { z } from 'zod';
import { mailboxRoleSchema, mailCategorySchema } from './folders';

// Long bodies are cut: search needs the gist, and Elasticsearch documents stay small.
export const MAX_INDEXED_BODY_CHARS = 32_000;

const indexedAddressSchema = z.object({
  name: z.string().max(500).nullable(),
  address: z.string().max(500),
});

// mail -> search: one message as search sees it.
export const searchDocumentSchema = z.object({
  messageId: z.string().min(1),
  userId: z.string().min(1),
  accountId: z.string().min(1),
  threadId: z.string().min(1),
  folder: z.string(),
  role: mailboxRoleSchema,
  from: indexedAddressSchema.nullable(),
  to: z.array(indexedAddressSchema),
  cc: z.array(indexedAddressSchema),
  subject: z.string(),
  body: z.string().max(MAX_INDEXED_BODY_CHARS),
  attachmentNames: z.array(z.string()),
  labels: z.array(z.string()),
  categories: z.array(mailCategorySchema),
  isRead: z.boolean(),
  isStarred: z.boolean(),
  sizeBytes: z.number().int().min(0),
  receivedAt: z.iso.datetime(),
});

// Rides the index queue (Elasticsearch) and the embed queue (Qdrant) alike.
export const indexPayloadSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('upsert'), doc: searchDocumentSchema }),
  z.object({ op: z.literal('delete'), messageId: z.string().min(1) }),
]);

export const SEARCH_MODES = ['keyword', 'semantic'] as const;
export const searchModeSchema = z.enum(SEARCH_MODES);

export type SearchDocument = z.infer<typeof searchDocumentSchema>;
export type IndexPayload = z.infer<typeof indexPayloadSchema>;
export type SearchMode = z.infer<typeof searchModeSchema>;
