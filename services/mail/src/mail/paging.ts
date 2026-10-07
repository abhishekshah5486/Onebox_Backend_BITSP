import type { Collection, Filter } from 'mongodb';
import type { ThreadDoc } from '../db/collections';
import { decodeCursor, encodeCursor, type ThreadCursor } from './cursor';

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
  // Anchor of the last item even when nothing older is stored yet, so a client can load the
  // page that a history fetch brings in.
  endCursor: string | null;
}

const anchor = (thread: ThreadDoc) =>
  encodeCursor({
    lastMessageAt: thread.lastMessageAt,
    lastUid: thread.lastUid ?? 0,
    id: thread._id,
  });

// Keyset comparison on (lastMessageAt, lastUid, _id), the same order the list is sorted in.
function beyond(position: ThreadCursor, op: '$lt' | '$gt'): Filter<ThreadDoc> {
  const { lastMessageAt, lastUid, id } = position;
  return {
    $or: [
      { lastMessageAt: { [op]: lastMessageAt } },
      { lastMessageAt, lastUid: { [op]: lastUid } },
      { lastMessageAt, lastUid, _id: { [op]: id } },
    ],
  };
}

export async function pageThreads(
  threads: Collection<ThreadDoc>,
  base: Filter<ThreadDoc>,
  { cursor, direction = 'next', limit = 50 }: PageInput,
): Promise<ThreadPage> {
  const position = cursor ? decodeCursor(cursor) : null;

  if (direction === 'prev' && position) {
    const newer = await threads
      .find({ ...base, ...beyond(position, '$gt') })
      .sort({ lastMessageAt: 1, lastUid: 1, _id: 1 })
      .limit(limit + 1)
      .toArray();
    const items = newer.slice(0, limit).reverse();
    const end = items.at(-1) ? anchor(items.at(-1)!) : null;
    return {
      items,
      prevCursor: newer.length > limit && items[0] ? anchor(items[0]) : null,
      nextCursor: end,
      endCursor: end,
    };
  }

  const older = await threads
    .find(position ? { ...base, ...beyond(position, '$lt') } : base)
    .sort({ lastMessageAt: -1, lastUid: -1, _id: -1 })
    .limit(limit + 1)
    .toArray();
  const items = older.slice(0, limit);
  const end = items.at(-1) ? anchor(items.at(-1)!) : null;
  return {
    items,
    nextCursor: older.length > limit ? end : null,
    prevCursor: position && items[0] ? anchor(items[0]) : null,
    endCursor: end,
  };
}
