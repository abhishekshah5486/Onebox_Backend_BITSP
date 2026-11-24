import { z } from 'zod';

// What the app is told live, so it can refresh just that part.
export const liveEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('thread.changed'), threadId: z.string(), accountId: z.string() }),
  z.object({ type: z.literal('thread.removed'), threadId: z.string() }),
]);

export type LiveEvent = z.infer<typeof liveEventSchema>;

// Redis pub/sub channel carrying one user's live events.
export const liveChannel = (userId: string) => `live:${userId}`;
export const LIVE_CHANNEL_PATTERN = 'live:*';
