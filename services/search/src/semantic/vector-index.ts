import { createHash } from 'node:crypto';
import type { SearchCopy, SearchDocument } from '@onebox/contracts';
import type { QdrantClient, Schemas } from '@qdrant/js-client-rest';
import { v5 as uuidv5 } from 'uuid';
import { labelsOf } from '../index-state';
import { HIDDEN_ROLES } from '../keyword/keyword-query';
import type { ParsedQuery } from '../query/parse';

// Enough for the gist of a mail while keeping each embedding cheap.
const MAX_EMBEDDED_CHARS = 8_000;
// Qdrant ids must be UUIDs, so email keys map onto one in a fixed namespace.
const POINT_NAMESPACE = '6f0c2a52-7d4b-4c55-9a8f-3a1d1b0e5c11';

export type Embed = (texts: string[]) => Promise<number[][]>;

export interface SemanticHit {
  threadId: string;
  messageId: string;
  score: number;
}

export const pointId = (key: string) => uuidv5(key, POINT_NAMESPACE);

export function embeddingText(doc: SearchDocument) {
  const from = doc.from ? `${doc.from.name ?? ''} <${doc.from.address}>`.trim() : '';
  return [`Subject: ${doc.subject}`, `From: ${from}`, '', doc.body]
    .join('\n')
    .slice(0, MAX_EMBEDDED_CHARS);
}

interface Payload {
  key: string;
  copies: SearchCopy[];
  roles: string[];
  aiLabels: string[];
  labels: string[];
  version: number;
  contentHash: string;
  [field: string]: unknown;
}

const placesOf = (doc: Pick<SearchDocument, 'labels' | 'copies'>) => ({
  copies: doc.copies,
  roles: [...new Set(doc.copies.map((copy) => copy.role))],
  aiLabels: doc.labels,
  labels: labelsOf(doc).map((label) => label.toLowerCase()),
});

const payloadOf = (doc: SearchDocument, version: number, contentHash: string): Payload => ({
  ...placesOf(doc),
  key: doc.key,
  userId: doc.userId,
  accountId: doc.accountId,
  threadId: doc.threadId,
  from: [doc.from?.name, doc.from?.address].filter(Boolean).join(' '),
  categories: doc.categories,
  isRead: doc.isRead,
  isStarred: doc.isStarred,
  hasAttachment: doc.attachmentNames.length > 0,
  sizeBytes: doc.sizeBytes,
  receivedAt: doc.receivedAt,
  version,
  contentHash,
});

const INDEXED_FIELDS: [string, Schemas['PayloadFieldSchema']][] = [
  ['userId', { type: 'keyword', is_tenant: true }],
  ['threadId', 'keyword'],
  ['roles', 'keyword'],
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
  if (query.in && query.in !== 'anywhere') must.push({ key: 'roles', match: { value: query.in } });
  if (!query.in) mustNot.push({ key: 'roles', match: { any: HIDDEN_ROLES } });
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

// Callers hold the email's lock, so reads and writes of one point don't interleave.
export function createVectorIndex(client: QdrantClient, collection: string, dimensions: number) {
  async function current(key: string) {
    const [point] = await client.retrieve(collection, {
      ids: [pointId(key)],
      with_payload: true,
      with_vector: false,
    });
    return point ? (point.payload as unknown as Payload) : null;
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

    // Embeds only when the text changed; returns what it did.
    async upsert(doc: SearchDocument, version: number, embed: Embed) {
      const id = pointId(doc.key);
      const contentHash = createHash('sha256').update(embeddingText(doc)).digest('hex');
      const payload = payloadOf(doc, version, contentHash);
      const existing = await current(doc.key);
      if (existing && existing.version > version) return 'stale' as const;
      if (existing?.contentHash === contentHash) {
        await client.overwritePayload(collection, { points: [id], payload, wait: true });
        return 'updated' as const;
      }
      const [vector] = await embed([embeddingText(doc)]);
      await client.upsert(collection, { points: [{ id, vector: vector!, payload }], wait: true });
      return 'embedded' as const;
    },

    // Many emails in one embedding call, for rebuilding with a new model. Unchanged text isn't
    // embedded again, so a rebuild that restarts picks up where it stopped. Returns how many
    // were embedded.
    async upsertMany(entries: { doc: SearchDocument; version: number }[], embed: Embed) {
      const points = await client.retrieve(collection, {
        ids: entries.map(({ doc }) => pointId(doc.key)),
        with_payload: ['version', 'contentHash'],
        with_vector: false,
      });
      const existing = new Map(points.map((point) => [String(point.id), point.payload]));
      const fresh = entries.flatMap(({ doc, version }) => {
        const id = pointId(doc.key);
        const text = embeddingText(doc);
        const contentHash = createHash('sha256').update(text).digest('hex');
        const before = existing.get(id);
        // A live write already put something newer here.
        if (before && Number(before.version) > version) return [];
        const payload = payloadOf(doc, version, contentHash);
        return [{ id, text, payload, same: before?.contentHash === contentHash }];
      });
      for (const { id, payload } of fresh.filter((entry) => entry.same)) {
        await client.overwritePayload(collection, { points: [id], payload, wait: true });
      }
      const changed = fresh.filter((entry) => !entry.same);
      if (changed.length === 0) return 0;
      const vectors = await embed(changed.map((entry) => entry.text));
      await client.upsert(collection, {
        points: changed.map(({ id, payload }, i) => ({ id, vector: vectors[i]!, payload })),
        wait: true,
      });
      return changed.length;
    },

    // A user's vectors, once they've moved to another model.
    removeUser: (userId: string) =>
      client.delete(collection, {
        filter: { must: [{ key: 'userId', match: { value: userId } }] },
        wait: true,
      }),

    // Drops one copy; the email goes with its last. Returns whether it is gone.
    async removeCopy(key: string, messageId: string, version: number) {
      const existing = await current(key);
      if (!existing || existing.version > version) return false;
      const copies = existing.copies.filter((copy) => copy.messageId !== messageId);
      if (copies.length === existing.copies.length) return false;
      if (copies.length === 0) {
        await client.delete(collection, { points: [pointId(key)], wait: true });
        return true;
      }
      await client.setPayload(collection, {
        points: [pointId(key)],
        payload: { ...placesOf({ labels: existing.aiLabels, copies }), version },
        wait: true,
      });
      return false;
    },

    // Best match per conversation.
    async search(userId: string, vector: number[], query: ParsedQuery, limit: number) {
      const { groups } = await client.queryGroups(collection, {
        query: vector,
        filter: vectorFilter(userId, query),
        group_by: 'threadId',
        group_size: 1,
        limit,
        with_payload: ['copies', 'threadId'],
      });
      return groups.flatMap((group): SemanticHit[] => {
        const hit = group.hits[0];
        const messageId = (hit?.payload?.copies as SearchCopy[] | undefined)?.[0]?.messageId;
        if (!hit || typeof messageId !== 'string') return [];
        return [{ threadId: String(group.id), messageId, score: hit.score }];
      });
    },

    collection,
    ping: () => client.versionInfo(),
  };
}

export type VectorIndex = ReturnType<typeof createVectorIndex>;
