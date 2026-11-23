import { describe, expect, it } from 'vitest';
import type { MessageDoc } from '../db/collections';
import { aiJob, freshText } from './ai-job';

describe('freshText', () => {
  it('keeps only the new part of a reply', () => {
    expect(
      freshText(
        'Sounds good, Tuesday works.\n\nOn Tue, Oct 6, 2026 at 10:00 Priya wrote:\n> Are you free?',
      ),
    ).toBe('Sounds good, Tuesday works.');
    expect(freshText('Hi\n> quoted\nThanks')).toBe('Hi\nThanks');
  });
});

describe('aiJob', () => {
  const doc = (categories: MessageDoc['categories']) =>
    ({
      _id: 'm1',
      userId: 'u1',
      accountId: 'a1',
      threadId: 't1',
      from: { name: 'Priya', address: 'priya@acme.example' },
      to: [],
      cc: [],
      subject: 'Order shipped',
      snippet: 'Your order is on its way',
      textBody: 'Your order is on its way',
      receivedAt: new Date('2026-11-20T10:00:00.000Z'),
      categories,
    }) as unknown as MessageDoc;

  it('asks for categories only when Gmail gave none', () => {
    expect(aiJob(doc([])).payload.categorize).toBe(true);
    expect(aiJob(doc(undefined)).payload.categorize).toBe(true);
    expect(aiJob(doc(['purchases'])).payload.categorize).toBe(false);
  });
});
