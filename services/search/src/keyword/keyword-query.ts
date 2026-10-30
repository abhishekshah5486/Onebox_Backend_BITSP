import type { estypes } from '@elastic/elasticsearch';
import type { ParsedQuery } from '../query/parse';

// Like Gmail, spam and trash are left out unless asked for.
export const HIDDEN_ROLES = ['spam', 'trash'];

const TEXT_FIELDS = [
  'subject^3',
  'from.name^2',
  'from.address^2',
  'to.name',
  'to.address',
  'cc.name',
  'cc.address',
  'body',
  'attachmentNames',
];

const address = (field: string, value: string): estypes.QueryDslQueryContainer => ({
  multi_match: {
    query: value,
    fields: [`${field}.name`, `${field}.address`],
    type: 'phrase',
  },
});

// Each operator narrows the results, as Gmail's do; free text must all match somewhere.
export function keywordQuery(
  userId: string,
  query: ParsedQuery,
): { bool: estypes.QueryDslBoolQuery } {
  const must: estypes.QueryDslQueryContainer[] = [];
  const filter: estypes.QueryDslQueryContainer[] = [{ term: { userId } }];
  const mustNot: estypes.QueryDslQueryContainer[] = [];

  if (query.words.length > 0) {
    must.push({
      multi_match: {
        query: query.words.join(' '),
        fields: TEXT_FIELDS,
        type: 'cross_fields',
        operator: 'and',
      },
    });
  }
  for (const phrase of query.phrases) {
    must.push({ multi_match: { query: phrase, fields: TEXT_FIELDS, type: 'phrase' } });
  }
  for (const word of query.excluded) {
    mustNot.push({ multi_match: { query: word, fields: TEXT_FIELDS, type: 'phrase' } });
  }
  must.push(...query.from.map((v) => address('from', v)));
  must.push(...query.to.map((v) => address('to', v)));
  must.push(...query.cc.map((v) => address('cc', v)));
  mustNot.push(...query.notFrom.map((v) => address('from', v)));
  for (const subject of query.subject) must.push({ match_phrase: { subject } });
  for (const name of query.filenames) {
    must.push({ match: { attachmentNames: { query: name, operator: 'and' } } });
  }

  filter.push(...query.labels.map((label) => ({ term: { labels: label } })));
  filter.push(...query.categories.map((category) => ({ term: { categories: category } })));
  if (query.in && query.in !== 'anywhere') filter.push({ term: { role: query.in } });
  if (!query.in) mustNot.push({ terms: { role: HIDDEN_ROLES } });
  if (query.isUnread !== null) filter.push({ term: { isRead: !query.isUnread } });
  if (query.isStarred) filter.push({ term: { isStarred: true } });
  if (query.hasAttachment) filter.push({ exists: { field: 'attachmentNames' } });
  if (query.largerThan !== null || query.smallerThan !== null) {
    filter.push({
      range: {
        sizeBytes: {
          ...(query.largerThan !== null && { gt: query.largerThan }),
          ...(query.smallerThan !== null && { lt: query.smallerThan }),
        },
      },
    });
  }
  if (query.after || query.before) {
    filter.push({
      range: {
        receivedAt: {
          ...(query.after && { gte: query.after.toISOString() }),
          ...(query.before && { lt: query.before.toISOString() }),
        },
      },
    });
  }

  return { bool: { must, filter, must_not: mustNot } };
}
