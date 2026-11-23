import { z } from 'zod';
import type { FolderRole } from './folders';

// Mail RAG does not read: unwanted, deleted, or still being written.
export const RAG_SKIPPED_ROLES: readonly FolderRole[] = ['spam', 'trash', 'drafts'];

const versionSchema = z.number().int().min(0);

// Rides the rag-mail queue. An email is one record in RAG, whichever folders hold its copies:
// upsert names the copies RAG may read it from; remove means none is left that RAG reads (all in
// spam, trash or drafts); delete removes one copy, and the email goes once its last copy does.
export const ragMailPayloadSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('upsert'),
    version: versionSchema,
    key: z.string().min(1).max(64),
    accountId: z.string().min(1),
    messageIds: z.array(z.string().min(1)).min(1).max(100),
  }),
  z.object({
    op: z.literal('remove'),
    version: versionSchema,
    key: z.string().min(1).max(64),
    accountId: z.string().min(1),
  }),
  z.object({ op: z.literal('delete'), version: versionSchema, messageId: z.string().min(1) }),
]);

export type RagMailPayload = z.infer<typeof ragMailPayloadSchema>;
