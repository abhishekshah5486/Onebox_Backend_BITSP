import { z } from 'zod';
import { folderRoleSchema, mailboxRoleSchema, mailCategorySchema } from './folders';

const uid = z.number().int().positive();
const uidValidity = z.number().int().nonnegative();
const path = z.string().min(1);

// Compact IMAP-style UID set ("1:5,9,12:14"), so a snapshot of a large folder stays small.
export function encodeUidSet(uids: Iterable<number>): string {
  const sorted = [...new Set(uids)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length;) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++;
    parts.push(i === j ? `${sorted[i]}` : `${sorted[i]}:${sorted[j]}`);
    i = j + 1;
  }
  return parts.join(',');
}

export function decodeUidSet(set: string): Set<number> {
  const result = new Set<number>();
  for (const part of set.split(',').filter(Boolean)) {
    const [from, to = from] = part.split(':').map(Number) as [number, number?];
    for (let n = from; n <= to; n++) result.add(n);
  }
  return result;
}

export const uidSetSchema = z.string().regex(/^(\d+(:\d+)?(,\d+(:\d+)?)*)?$/, 'invalid uid set');

// A system folder by role (the connector finds its path), or a label by its path.
export const mailboxTargetSchema = z.union([
  z.object({ role: folderRoleSchema }),
  z.object({ label: path }),
]);

export type MailboxTarget = z.infer<typeof mailboxTargetSchema>;

export const SYNCED_FLAGS = ['\\Seen', '\\Flagged'] as const;

// OneBox -> mail server: one change to a set of messages in one folder.
export const messageOpSchema = z.object({
  folder: path,
  uidValidity,
  uids: z.array(uid).min(1).max(1000),
  op: z.discriminatedUnion('type', [
    z.object({
      type: z.literal('flags'),
      add: z.array(z.enum(SYNCED_FLAGS)),
      remove: z.array(z.enum(SYNCED_FLAGS)),
    }),
    z.object({ type: z.literal('move'), to: mailboxTargetSchema }),
    // Permanent deletion, offered only in Trash and Spam.
    z.object({ type: z.literal('expunge') }),
  ]),
});

// OneBox -> mail server: create, rename or delete one of the user's labels (folders).
export const labelOpSchema = z.object({
  kind: z.literal('label'),
  op: z.discriminatedUnion('type', [
    z.object({ type: z.literal('create'), name: path }),
    z.object({ type: z.literal('rename'), path, name: path }),
    z.object({ type: z.literal('delete'), path }),
  ]),
});

// OneBox -> mail server: copy one message's raw source into the blob store under `key`, for
// mail stored before attachment contents were kept.
export const sourceOpSchema = z.object({
  kind: z.literal('source'),
  folder: path,
  uidValidity,
  uid,
  key: z.string().min(1).max(512),
});

export const mailboxOpPayloadSchema = z.union([messageOpSchema, labelOpSchema, sourceOpSchema]);

export type MessageOpPayload = z.infer<typeof messageOpSchema>;
export type LabelOpPayload = z.infer<typeof labelOpSchema>;
export type SourceOpPayload = z.infer<typeof sourceOpSchema>;
export type MailboxOpPayload = z.infer<typeof mailboxOpPayloadSchema>;

const flagUpdate = z.object({ uid, flags: z.array(z.string()) });

// Mail server -> OneBox: what actually happened, so the stored copy follows the server.
export const mailboxChangePayloadSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('moved'),
    folder: path,
    uidValidity,
    to: z.object({ folder: path, role: mailboxRoleSchema, uidValidity }),
    // [source uid, destination uid]; Gmail's All Mail keeps its copy, so the source stays.
    uidMap: z.array(z.tuple([uid, uid])),
    keepSource: z.boolean().default(false),
  }),
  z.object({ type: z.literal('removed'), folder: path, uidValidity, uids: z.array(uid) }),
  z.object({ type: z.literal('flags'), folder: path, uidValidity, flags: z.array(flagUpdate) }),
  // An operation finished (or failed for good): the server is authoritative again.
  z.object({ type: z.literal('settled'), folder: path, uidValidity, uids: z.array(uid) }),
  // A label was renamed or deleted, so every stored message in it moves with it or goes.
  z.object({ type: z.literal('folderRenamed'), folder: path, to: path }),
  z.object({ type: z.literal('folderGone'), folder: path }),
  // AI (or the user, from a suggestion) put labels on a message in OneBox.
  z.object({
    type: z.literal('tagged'),
    messageId: z.string().min(1),
    add: z.array(path),
    remove: z.array(path).default([]),
  }),
  // Everything in a folder right now; stored messages missing from it were moved or deleted.
  z.object({
    type: z.literal('snapshot'),
    folder: path,
    role: mailboxRoleSchema,
    uidValidity,
    // Anything at or above this arrived after the snapshot, so its absence means nothing.
    uidNext: uid,
    present: uidSetSchema,
    flags: z.array(flagUpdate).default([]),
    categories: z.partialRecord(mailCategorySchema, uidSetSchema).optional(),
  }),
]);

export type MailboxChangePayload = z.infer<typeof mailboxChangePayloadSchema>;
