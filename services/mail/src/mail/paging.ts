import type { Collection, Filter } from 'mongodb';
import type { ThreadDoc } from '../db/collections';
import { decodeCursor, encodeCursor } from './cursor';

export type Direction = 'next' | 'prev';

export interface PageInput {
  cursor?: string | undefined;
  direction?: Direction | undefined;
  limit?: number | undefined;
}

export interface ThreadPage {
  items: ThreadDoc[];
  // next = older conversations, prev = newer ones. Cursors anchor to a conversation, not an offset,
  // so mail arriving while the user reads page 3 never shifts what page 3 shows.
  nextCursor: string | null;
  prevCursor: string | null;
}

const anchor = (thread: ThreadDoc) =>
  encodeCursor({ lastMessageAt: thread.lastMessageAt, id: thread._id });

export async function pageThreads(
  threads: Collection<ThreadDoc>,
  base: Filter<ThreadDoc>,
  { cursor, direction = 'next', limit = 50 }: PageInput,
): Promise<ThreadPage> {
  const position = cursor ? decodeCursor(cursor) : null;

  if (direction === 'prev' && position) {
    const newer = await threads
      .find({
        ...base,
        $or: [
          { lastMessageAt: { $gt: position.lastMessageAt } },
          { lastMessageAt: position.lastMessageAt, _id: { $gt: position.id } },
        ],
      })
      .sort({ lastMessageAt: 1, _id: 1 })
      .limit(limit + 1)
      .toArray();
    const items = newer.slice(0, limit).reverse();
    return {
      items,
      prevCursor: newer.length > limit && items[0] ? anchor(items[0]) : null,
      nextCursor: items.at(-1) ? anchor(items.at(-1)!) : null,
    };
  }

  const older = await threads
    .find(
      position
        ? {
            ...base,
            $or: [
              { lastMessageAt: { $lt: position.lastMessageAt } },
              { lastMessageAt: position.lastMessageAt, _id: { $lt: position.id } },
            ],
          }
        : base,
    )
    .sort({ lastMessageAt: -1, _id: -1 })
    .limit(limit + 1)
    .toArray();
  const items = older.slice(0, limit);
  return {
    items,
    nextCursor: older.length > limit && items.at(-1) ? anchor(items.at(-1)!) : null,
    prevCursor: position && items[0] ? anchor(items[0]) : null,
  };
}
