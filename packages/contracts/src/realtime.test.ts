import { describe, expect, it } from 'vitest';
import { liveChannel, liveEventSchema } from './realtime';

describe('live events', () => {
  it('names a channel per user and checks event shapes', () => {
    expect(liveChannel('u1')).toBe('live:u1');
    expect(liveEventSchema.safeParse({ type: 'thread.removed', threadId: 't1' }).success).toBe(
      true,
    );
    expect(liveEventSchema.safeParse({ type: 'thread.changed', threadId: 't1' }).success).toBe(
      false,
    );
  });
});
