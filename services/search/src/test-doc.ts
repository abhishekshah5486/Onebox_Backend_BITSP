import type { SearchDocument } from '@onebox/contracts';

export function searchDoc(overrides: Partial<SearchDocument> = {}): SearchDocument {
  return {
    messageId: 'm1',
    userId: 'u1',
    accountId: 'a1',
    threadId: 't1',
    folder: 'INBOX',
    role: 'inbox',
    from: { name: 'Alice Smith', address: 'alice@example.com' },
    to: [{ name: null, address: 'me@example.com' }],
    cc: [],
    subject: 'Hello',
    body: 'Just saying hi',
    attachmentNames: [],
    labels: [],
    categories: [],
    isRead: true,
    isStarred: false,
    sizeBytes: 1_000,
    receivedAt: '2026-10-01T10:00:00.000Z',
    ...overrides,
  };
}
