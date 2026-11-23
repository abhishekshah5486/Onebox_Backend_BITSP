import { createHash } from 'node:crypto';
import type { SearchCopy, SearchDocument } from '@onebox/contracts';
import type { Collection } from '@onebox/vector-stores';
import { HIDDEN_ROLES } from '../keyword/keyword-query';
import type { ParsedQuery } from '../query/parse';
import {
  embeddingText,
  payloadOf,
  placesOf,
  pointId,
  type Embed,
  type Payload,
  type SemanticHit,
} from './vector-index';

// Matches are fetched this many times over what's asked for, as the query's filters are applied
// here rather than in the store.
const OVERFETCH = 10;
const MAX_FETCH = 1_000;

const words = (text: string) =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

// The same conditions vectorFilter gives Qdrant, checked against a stored payload.
export function matchesQuery(payload: Payload, query: ParsedQuery) {
  const roles = payload.roles;
  const has = (list: unknown, value: string) => Array.isArray(list) && list.includes(value);
  const fromWords = new Set(words(typeof payload.from === 'string' ? payload.from : ''));
  if (!query.from.every((from) => words(from).every((word) => fromWords.has(word)))) return false;
  if (!query.labels.every((label) => has(payload.labels, label.toLowerCase()))) return false;
  if (!query.categories.every((category) => has(payload.categories, category))) return false;
  if (query.in && query.in !== 'anywhere' && !roles.includes(query.in)) return false;
  if (!query.in && roles.some((role) => HIDDEN_ROLES.includes(role))) return false;
  if (query.isUnread !== null && payload.isRead !== !query.isUnread) return false;
  if (query.isStarred && payload.isStarred !== true) return false;
  if (query.hasAttachment && payload.hasAttachment !== true) return false;
  const size = Number(payload.sizeBytes);
  if (query.largerThan !== null && !(size > query.largerThan)) return false;
  if (query.smallerThan !== null && !(size < query.smallerThan)) return false;
  const received = Date.parse(String(payload.receivedAt));
  if (query.after && !(received >= query.after.getTime())) return false;
  if (query.before && !(received < query.before.getTime())) return false;
  return true;
}

// The vector index for a user's own store other than Qdrant: same behaviour as the Qdrant
// index, on any database that can store, fetch and nearest-match vectors per user.
export function createStoreIndex(store: Collection, ping: () => Promise<unknown>) {
  const one = async (userId: string, key: string, withVectors: boolean) =>
    (await store.get(userId, [pointId(key)], withVectors))[0] ?? null;

  return {
    ensure: () => store.ensure(),

    async upsert(doc: SearchDocument, version: number, embed: Embed) {
      const contentHash = createHash('sha256').update(embeddingText(doc)).digest('hex');
      const payload = payloadOf(doc, version, contentHash);
      const existing = await one(doc.userId, doc.key, true);
      const before = existing?.payload as Payload | undefined;
      if (before && before.version > version) return 'stale' as const;
      if (before?.contentHash === contentHash && existing?.vector) {
        await store.upsert(doc.userId, [
          { id: pointId(doc.key), vector: existing.vector, payload },
        ]);
        return 'updated' as const;
      }
      const [vector] = await embed([embeddingText(doc)]);
      await store.upsert(doc.userId, [{ id: pointId(doc.key), vector: vector!, payload }]);
      return 'embedded' as const;
    },

    async upsertMany(entries: { doc: SearchDocument; version: number }[], embed: Embed) {
      if (!entries.length) return 0;
      const userId = entries[0]!.doc.userId;
      const stored = await store.get(
        userId,
        entries.map(({ doc }) => pointId(doc.key)),
        true,
      );
      const existing = new Map(stored.map((point) => [point.id, point]));
      const fresh = entries.flatMap(({ doc, version }) => {
        const id = pointId(doc.key);
        const text = embeddingText(doc);
        const contentHash = createHash('sha256').update(text).digest('hex');
        const before = existing.get(id);
        const old = before?.payload as Payload | undefined;
        if (old && Number(old.version) > version) return [];
        const payload = payloadOf(doc, version, contentHash);
        const kept = old?.contentHash === contentHash ? before?.vector : null;
        return [{ id, text, payload, kept }];
      });
      const same = fresh.filter((entry) => entry.kept);
      if (same.length) {
        await store.upsert(
          userId,
          same.map(({ id, payload, kept }) => ({ id, payload, vector: kept! })),
        );
      }
      const changed = fresh.filter((entry) => !entry.kept);
      if (!changed.length) return 0;
      const vectors = await embed(changed.map((entry) => entry.text));
      await store.upsert(
        userId,
        changed.map(({ id, payload }, i) => ({ id, payload, vector: vectors[i]! })),
      );
      return changed.length;
    },

    removeUser: (userId: string) => store.deleteUser(userId),

    async removeCopy(key: string, messageId: string, version: number, userId?: string) {
      if (!userId) throw new Error('removing a copy from an own store needs the user');
      const existing = await one(userId, key, true);
      const payload = existing?.payload as Payload | undefined;
      if (!existing || !payload || payload.version > version) return false;
      const copies = payload.copies.filter((copy: SearchCopy) => copy.messageId !== messageId);
      if (copies.length === payload.copies.length) return false;
      if (copies.length === 0) {
        await store.delete(userId, [existing.id]);
        return true;
      }
      await store.upsert(userId, [
        {
          id: existing.id,
          vector: existing.vector!,
          payload: { ...payload, ...placesOf({ labels: payload.aiLabels, copies }), version },
        },
      ]);
      return false;
    },

    // Best match per conversation, filtered here.
    async search(userId: string, vector: number[], query: ParsedQuery, limit: number) {
      const hits = await store.query(userId, vector, Math.min(limit * OVERFETCH, MAX_FETCH));
      const best = new Map<string, SemanticHit>();
      for (const hit of hits.sort((a, b) => b.score - a.score)) {
        const payload = hit.payload as Payload;
        if (!matchesQuery(payload, query)) continue;
        const threadId = String(payload.threadId);
        const messageId = payload.copies[0]?.messageId;
        if (best.has(threadId) || typeof messageId !== 'string') continue;
        best.set(threadId, { threadId, messageId, score: hit.score });
        if (best.size >= limit) break;
      }
      return [...best.values()];
    },

    collection: store.name,
    ping,
  };
}
