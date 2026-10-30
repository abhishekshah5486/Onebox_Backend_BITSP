import { createJobEnvelope, type IndexPayload, type SearchDocument } from '@onebox/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { KeywordIndex } from './keyword/keyword-index';
import type { Embed, VectorIndex } from './semantic/vector-index';
import { keywordHandler, vectorHandler } from './workers';

const doc = { messageId: 'm1', userId: 'u1' } as SearchDocument;
const job = (payload: IndexPayload) => createJobEnvelope({ jobId: 'j1', userId: 'u1', payload });

describe('keywordHandler', () => {
  it('indexes and removes messages', async () => {
    const keyword = { upsert: vi.fn(), remove: vi.fn() };
    const handle = keywordHandler(keyword as unknown as KeywordIndex);
    await handle(job({ op: 'upsert', doc }));
    await handle(job({ op: 'delete', messageId: 'm1' }));
    expect(keyword.upsert).toHaveBeenCalledWith(doc);
    expect(keyword.remove).toHaveBeenCalledWith('m1');
  });
});

describe('vectorHandler', () => {
  it('embeds new messages without charging the user', async () => {
    const vector = {
      upsert: vi.fn(async (_doc: SearchDocument, embed: Embed) => {
        await embed(['text']);
        return true;
      }),
      remove: vi.fn(),
    };
    const embed = vi.fn(async () => [[1]]);
    const handle = vectorHandler(vector as unknown as VectorIndex, embed);
    await handle(job({ op: 'upsert', doc }));
    await handle(job({ op: 'delete', messageId: 'm1' }));
    expect(embed).toHaveBeenCalledWith({ userId: 'u1', texts: ['text'], charge: false });
    expect(vector.remove).toHaveBeenCalledWith('m1');
  });
});
