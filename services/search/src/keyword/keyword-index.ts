import { errors, type Client, type estypes } from '@elastic/elasticsearch';
import type { SearchDocument } from '@onebox/contracts';
import { labelsOf } from '../index-state';
import type { ParsedQuery } from '../query/parse';
import { keywordQuery } from './keyword-query';

const address: estypes.MappingProperty = {
  properties: {
    name: { type: 'text' },
    address: {
      type: 'text',
      analyzer: 'parts',
      fields: { raw: { type: 'keyword', normalizer: 'lowercase' } },
    },
  },
};

export const MESSAGE_SETTINGS: estypes.IndicesIndexSettings = {
  analysis: {
    normalizer: { lowercase: { type: 'custom', filter: ['lowercase'] } },
    // Splits at punctuation, so from:shop finds deals@shop.com and filename:pdf finds a.pdf.
    tokenizer: { parts: { type: 'pattern', pattern: '[^\\p{L}\\p{N}]+' } },
    analyzer: { parts: { type: 'custom', tokenizer: 'parts', filter: ['lowercase'] } },
  },
};

export const MESSAGE_MAPPINGS: estypes.MappingTypeMapping = {
  dynamic: 'strict',
  properties: {
    key: { type: 'keyword' },
    copies: {
      properties: {
        messageId: { type: 'keyword' },
        folder: { type: 'keyword' },
        role: { type: 'keyword' },
      },
    },
    userId: { type: 'keyword' },
    accountId: { type: 'keyword' },
    threadId: { type: 'keyword' },
    from: address,
    to: address,
    cc: address,
    // Stemmed, so flight finds flights.
    subject: { type: 'text', analyzer: 'english' },
    body: { type: 'text', analyzer: 'english' },
    attachmentNames: { type: 'text', analyzer: 'parts' },
    // AI labels and label folders together; the AI's alone are kept to rebuild them.
    labels: { type: 'keyword', normalizer: 'lowercase' },
    aiLabels: { type: 'keyword', index: false },
    categories: { type: 'keyword' },
    isRead: { type: 'boolean' },
    isStarred: { type: 'boolean' },
    sizeBytes: { type: 'long' },
    receivedAt: { type: 'date' },
  },
};

export interface KeywordHit {
  threadId: string;
  messageId: string;
  score: number | null;
  highlights: string[];
}

type StoredDocument = SearchDocument & { aiLabels: string[] };

const stored = (doc: SearchDocument): StoredDocument => ({
  ...doc,
  labels: labelsOf(doc),
  aiLabels: doc.labels,
});

// A newer write already landed; this one is stale and dropped.
const isConflict = (err: unknown) => err instanceof errors.ResponseError && err.statusCode === 409;

export function createKeywordIndex(client: Client, index: string) {
  // External versions: Elasticsearch keeps whichever write carries the latest change.
  async function write(doc: StoredDocument, version: number) {
    try {
      await client.index({
        index,
        id: doc.key,
        document: doc,
        version,
        version_type: 'external_gte',
      });
      return true;
    } catch (err) {
      if (isConflict(err)) return false;
      throw err;
    }
  }

  return {
    async ensure() {
      if (await client.indices.exists({ index })) return;
      await client.indices.create(
        {
          index,
          settings: MESSAGE_SETTINGS,
          mappings: MESSAGE_MAPPINGS,
        },
        // Another replica may create it first.
        { ignore: [400] },
      );
    },

    upsert: (doc: SearchDocument, version: number) => write(stored(doc), version),

    // Drops one copy; the email goes with its last. Returns whether it is gone.
    async removeCopy(key: string, messageId: string, version: number) {
      const current = await client.get<StoredDocument>({ index, id: key }, { ignore: [404] });
      if (!current.found || !current._source) return false;
      const copies = current._source.copies.filter((copy) => copy.messageId !== messageId);
      if (copies.length === current._source.copies.length) return false;
      if (copies.length > 0) {
        await write(
          stored({ ...current._source, labels: current._source.aiLabels, copies }),
          version,
        );
        return false;
      }
      try {
        await client.delete(
          { index, id: key, version, version_type: 'external_gte' },
          { ignore: [404] },
        );
        return true;
      } catch (err) {
        if (isConflict(err)) return false;
        throw err;
      }
    },

    // One hit per conversation, newest first; total counts conversations.
    async search(
      userId: string,
      query: ParsedQuery,
      { from, size }: { from: number; size: number },
    ) {
      const response = await client.search<SearchDocument>({
        index,
        query: keywordQuery(userId, query),
        sort: [{ receivedAt: 'desc' }],
        collapse: { field: 'threadId' },
        from,
        size,
        track_total_hits: false,
        aggs: { threads: { cardinality: { field: 'threadId' } } },
        _source: ['threadId', 'copies.messageId'],
        highlight: {
          // Escapes the mail's own markup so only <mark> reaches the app.
          encoder: 'html',
          fields: { subject: {}, body: { fragment_size: 140, number_of_fragments: 1 } },
          pre_tags: ['<mark>'],
          post_tags: ['</mark>'],
        },
      });
      const threads = response.aggregations?.threads as estypes.AggregationsCardinalityAggregate;
      const hits: KeywordHit[] = response.hits.hits.map((hit) => ({
        threadId: hit._source!.threadId,
        messageId: hit._source!.copies[0]!.messageId,
        score: hit._score ?? null,
        highlights: [...(hit.highlight?.subject ?? []), ...(hit.highlight?.body ?? [])],
      }));
      return { hits, total: threads?.value ?? hits.length };
    },

    ping: () => client.ping(),
  };
}

export type KeywordIndex = ReturnType<typeof createKeywordIndex>;
