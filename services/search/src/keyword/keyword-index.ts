import type { Client, estypes } from '@elastic/elasticsearch';
import type { SearchDocument } from '@onebox/contracts';
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
    messageId: { type: 'keyword' },
    userId: { type: 'keyword' },
    accountId: { type: 'keyword' },
    threadId: { type: 'keyword' },
    folder: { type: 'keyword' },
    role: { type: 'keyword' },
    from: address,
    to: address,
    cc: address,
    // Stemmed, so flight finds flights.
    subject: { type: 'text', analyzer: 'english' },
    body: { type: 'text', analyzer: 'english' },
    attachmentNames: { type: 'text', analyzer: 'parts' },
    labels: { type: 'keyword', normalizer: 'lowercase' },
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

export function createKeywordIndex(client: Client, index: string) {
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

    async upsert(doc: SearchDocument) {
      await client.index({ index, id: doc.messageId, document: doc });
    },

    async remove(messageId: string) {
      await client.delete({ index, id: messageId }, { ignore: [404] });
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
        _source: ['threadId', 'messageId'],
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
        messageId: hit._source!.messageId,
        score: hit._score ?? null,
        highlights: [...(hit.highlight?.subject ?? []), ...(hit.highlight?.body ?? [])],
      }));
      return { hits, total: threads?.value ?? hits.length };
    },

    ping: () => client.ping(),
  };
}

export type KeywordIndex = ReturnType<typeof createKeywordIndex>;
