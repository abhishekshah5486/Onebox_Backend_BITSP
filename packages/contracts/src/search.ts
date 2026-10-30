import { z } from 'zod';
import { mailboxRoleSchema, mailCategorySchema } from './folders';

// Long bodies are cut: search needs the gist, and Elasticsearch documents stay small.
export const MAX_INDEXED_BODY_CHARS = 32_000;

const indexedAddressSchema = z.object({
  name: z.string().max(500).nullable(),
  address: z.string().max(500),
});

// One stored copy of an email: mail keeps one per folder it sits in.
const searchCopySchema = z.object({
  messageId: z.string().min(1),
  folder: z.string(),
  role: mailboxRoleSchema,
});

// mail -> search: one email as search sees it, however many folders hold it.
export const searchDocumentSchema = z.object({
  key: z.string().min(1),
  copies: z.array(searchCopySchema).min(1),
  userId: z.string().min(1),
  accountId: z.string().min(1),
  threadId: z.string().min(1),
  from: indexedAddressSchema.nullable(),
  to: z.array(indexedAddressSchema),
  cc: z.array(indexedAddressSchema),
  subject: z.string(),
  body: z.string().max(MAX_INDEXED_BODY_CHARS),
  attachmentNames: z.array(z.string()),
  // AI labels; label folders come from the copies.
  labels: z.array(z.string()),
  categories: z.array(mailCategorySchema),
  isRead: z.boolean(),
  isStarred: z.boolean(),
  sizeBytes: z.number().int().min(0),
  receivedAt: z.iso.datetime(),
});

// When the change happened (database cluster time), so a late, older write never wins.
const versionSchema = z.number().int().min(0);

// Rides the index queue (Elasticsearch) and the embed queue (Qdrant) alike.
// A delete removes one copy; the email goes once its last copy does.
export const indexPayloadSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('upsert'), version: versionSchema, doc: searchDocumentSchema }),
  z.object({ op: z.literal('delete'), version: versionSchema, messageId: z.string().min(1) }),
]);

export const SEARCH_MODES = ['keyword', 'semantic'] as const;
export const searchModeSchema = z.enum(SEARCH_MODES);

export type SearchDocument = z.infer<typeof searchDocumentSchema>;
export type SearchCopy = z.infer<typeof searchCopySchema>;
export type IndexPayload = z.infer<typeof indexPayloadSchema>;
export type SearchMode = z.infer<typeof searchModeSchema>;
