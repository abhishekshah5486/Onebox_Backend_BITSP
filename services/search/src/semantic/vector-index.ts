import { createHash } from 'node:crypto';
import type { SearchDocument } from '@onebox/contracts';
import type { QdrantClient, Schemas } from '@qdrant/js-client-rest';
import { v5 as uuidv5 } from 'uuid';
import { HIDDEN_ROLES } from '../keyword/keyword-query';
import type { ParsedQuery } from '../query/parse';

// Enough for the gist of a mail while keeping each embedding cheap.
const MAX_EMBEDDED_CHARS = 8_000;
// Qdrant ids must be UUIDs, so message ids map onto one in a fixed namespace.
const POINT_NAMESPACE = '6f0c2a52-7d4b-4c55-9a8f-3a1d1b0e5c11';

export type Embed = (texts: string[]) => Promise<number[][]>;

export interface SemanticHit {
  threadId: string;
  messageId: string;
  score: number;
}

export const pointId = (messageId: string) => uuidv5(messageId, POINT_NAMESPACE);

export function embeddingText(doc: SearchDocument) {
  const from = doc.from ? `${doc.from.name ?? ''} <${doc.from.address}>`.trim() : '';
  return [`Subject: ${doc.subject}`, `From: ${from}`, '', doc.body]
    .join('\n')
    .slice(0, MAX_EMBEDDED_CHARS);
}

const payloadOf = (doc: SearchDocument, contentHash: string) => ({
  messageId: doc.messageId,
  userId: doc.userId,
  accountId: doc.accountId,
  threadId: doc.threadId,
  role: doc.role,
  from: [doc.from?.name, doc.from?.address].filter(Boolean).join(' '),
  labels: doc.labels.map((label) => label.toLowerCase()),
  categories: doc.categories,
  isRead: doc.isRead,
  isStarred: doc.isStarred,
  hasAttachment: doc.attachmentNames.length > 0,
  sizeBytes: doc.sizeBytes,
  receivedAt: doc.receivedAt,
  contentHash,
});

const INDEXED_FIELDS: [string, Schemas['PayloadFieldSchema']][] = [
  ['userId', { type: 'keyword', is_tenant: true }],
  ['threadId', 'keyword'],
  ['role', 'keyword'],
  ['labels', 'keyword'],
  ['categories', 'keyword'],
  ['contentHash', 'keyword'],
  ['isRead', 'bool'],
  ['isStarred', 'bool'],
  ['hasAttachment', 'bool'],
  ['sizeBytes', 'integer'],
  ['receivedAt', 'datetime'],
  ['from', { type: 'text', tokenizer: 'word', lowercase: true }],
];

// Payload conditions for the operators that still make sense next to a meaning-based search.
export function vectorFilter(userId: string, query: ParsedQuery): Schemas['Filter'] {
  const must: Schemas['Condition'][] = [{ key: 'userId', match: { value: userId } }];
  const mustNot: Schemas['Condition'][] = [];
  for (const from of query.from) must.push({ key: 'from', match: { text: from } });
  for (const label of query.labels)
    must.push({ key: 'labels', match: { value: label.toLowerCase() } });
  for (const category of query.categories)
    must.push({ key: 'categories', match: { value: category } });
  if (query.in && query.in !== 'anywhere') must.push({ key: 'role', match: { value: query.in } });
  if (!query.in) mustNot.push({ key: 'role', match: { any: HIDDEN_ROLES } });
  if (query.isUnread !== null) must.push({ key: 'isRead', match: { value: !query.isUnread } });
  if (query.isStarred) must.push({ key: 'isStarred', match: { value: true } });
  if (query.hasAttachment) must.push({ key: 'hasAttachment', match: { value: true } });
  if (query.largerThan !== null || query.smallerThan !== null) {
    must.push({
      key: 'sizeBytes',
      range: {
        ...(query.largerThan !== null && { gt: query.largerThan }),
        ...(query.smallerThan !== null && { lt: query.smallerThan }),
      },
    });
  }
  if (query.after || query.before) {
    must.push({
      key: 'receivedAt',
      range: {
        ...(query.after && { gte: query.after.toISOString() }),
        ...(query.before && { lt: query.before.toISOString() }),
      },
    });
  }
  return { must, must_not: mustNot };
}

export function createVectorIndex(client: QdrantClient, collection: string, dimensions: number) {
  // The same mail is stored once per folder; an existing vector for its text is reused.
  async function vectorFor(doc: SearchDocument, contentHash: string, embed: Embed) {
    const { points } = await client.scroll(collection, {
      filter: {
        must: [
          { key: 'userId', match: { value: doc.userId } },
          { key: 'contentHash', match: { value: contentHash } },
        ],
      },
      limit: 1,
      with_vector: true,
      with_payload: false,
    });
    const existing = points[0]?.vector;
    if (Array.isArray(existing) && typeof existing[0] === 'number') return existing as number[];
    const [vector] = await embed([embeddingText(doc)]);
    return vector!;
  }

  return {
    async ensure() {
      const { exists } = await client.collectionExists(collection);
      if (!exists) {
        await client
          .createCollection(collection, { vectors: { size: dimensions, distance: 'Cosine' } })
          .catch(async (err: unknown) => {
            // Another replica may create it first.
            if (!(await client.collectionExists(collection)).exists) throw err;
          });
      }
      for (const [field_name, field_schema] of INDEXED_FIELDS) {
        await client.createPayloadIndex(collection, { field_name, field_schema, wait: true });
      }
    },

    // Returns whether a new embedding was needed.
    async upsert(doc: SearchDocument, embed: Embed) {
      const id = pointId(doc.messageId);
      const contentHash = createHash('sha256').update(embeddingText(doc)).digest('hex');
      const payload = payloadOf(doc, contentHash);
      const [current] = await client.retrieve(collection, {
        ids: [id],
        with_payload: ['contentHash'],
        with_vector: false,
      });
      if (current?.payload?.contentHash === contentHash) {
        await client.overwritePayload(collection, { points: [id], payload, wait: true });
        return false;
      }
      const vector = await vectorFor(doc, contentHash, embed);
      await client.upsert(collection, { points: [{ id, vector, payload }], wait: true });
      return true;
    },

    async remove(messageId: string) {
      await client.delete(collection, { points: [pointId(messageId)], wait: true });
    },

    // Best match per conversation.
    async search(userId: string, vector: number[], query: ParsedQuery, limit: number) {
      const { groups } = await client.queryGroups(collection, {
        query: vector,
        filter: vectorFilter(userId, query),
        group_by: 'threadId',
        group_size: 1,
        limit,
        with_payload: ['messageId', 'threadId'],
      });
      return groups.flatMap((group): SemanticHit[] => {
        const hit = group.hits[0];
        const messageId = hit?.payload?.messageId;
        if (!hit || typeof messageId !== 'string') return [];
        return [{ threadId: String(group.id), messageId, score: hit.score }];
      });
    },

    ping: () => client.versionInfo(),
  };
}

export type VectorIndex = ReturnType<typeof createVectorIndex>;
