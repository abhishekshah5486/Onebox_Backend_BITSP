import type { Collection, Filter } from 'mongodb';
import type { ThreadDoc } from '../db/collections';

export const PAGE_SIZE = 50;

export interface PageInput {
  page?: number | undefined;
  limit?: number | undefined;
}

export interface ThreadPage {
  items: ThreadDoc[];
  page: number;
  pageSize: number;
  // Conversations stored for this view; pages beyond it may need older mail fetched first.
  total: number;
}

// Plain page numbers over the stored list, newest first, like Gmail: if new mail arrives the
// list simply shifts down, and a page can never come back empty while mail exists past it.
export async function pageThreads(
  threads: Collection<ThreadDoc>,
  filter: Filter<ThreadDoc>,
  { page = 1, limit = PAGE_SIZE }: PageInput,
): Promise<ThreadPage> {
  const [items, total] = await Promise.all([
    threads
      .find(filter)
      .sort({ lastMessageAt: -1, lastUid: -1, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .toArray(),
    threads.countDocuments(filter),
  ]);
  return { items, page, pageSize: limit, total };
}
