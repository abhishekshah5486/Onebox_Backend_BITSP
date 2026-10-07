import type { Address, MailCollections, MessageDoc } from '../db/collections';
import { isReplySubject, normalizeSubject } from './subject';

const SUBJECT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_PARTICIPANTS = 20;

export interface ThreadLookup {
  userId: string;
  accountId: string;
  dedupeKey: string;
  messageIdHeader: string | null;
  inReplyTo: string | null;
  references: string[];
  subject: string;
  receivedAt: Date;
}

export async function resolveThreadId({ messages, threads }: MailCollections, input: ThreadLookup) {
  const scope = { userId: input.userId, accountId: input.accountId };
  const parents = [
    ...new Set([input.inReplyTo, ...input.references].filter((id): id is string => !!id)),
  ];

  if (parents.length > 0) {
    const parent = await messages.findOne(
      { ...scope, messageIdHeader: { $in: parents } },
      { projection: { threadId: 1 } },
    );
    if (parent) return parent.threadId;
  }

  // During backfill a reply can be stored before the message it answers.
  if (input.messageIdHeader) {
    const child = await messages.findOne(
      {
        ...scope,
        $or: [{ inReplyTo: input.messageIdHeader }, { references: input.messageIdHeader }],
      },
      { projection: { threadId: 1 } },
    );
    if (child) return child.threadId;
  }

  const normalizedSubject = normalizeSubject(input.subject);
  if (normalizedSubject && (parents.length > 0 || isReplySubject(input.subject))) {
    const match = await threads.findOne(
      {
        ...scope,
        normalizedSubject,
        lastMessageAt: { $gte: new Date(input.receivedAt.getTime() - SUBJECT_WINDOW_MS) },
      },
      { sort: { lastMessageAt: -1 }, projection: { _id: 1 } },
    );
    if (match) return match._id;
  }

  // A new thread's id derives from its first message, so a retried ingest reuses it.
  return input.dedupeKey;
}

// Two related messages ingested in parallel can each start a thread before seeing the other.
// Whichever finishes second finds the first here, and both converge on the same winner.
export async function mergeRelatedThreads(
  collections: MailCollections,
  input: Pick<
    ThreadLookup,
    'userId' | 'accountId' | 'dedupeKey' | 'messageIdHeader' | 'inReplyTo' | 'references'
  >,
  threadId: string,
): Promise<string> {
  const parents = [
    ...new Set([input.inReplyTo, ...input.references].filter((id): id is string => !!id)),
  ];
  const links = [
    ...(parents.length > 0 ? [{ messageIdHeader: { $in: parents } }] : []),
    ...(input.messageIdHeader
      ? [{ inReplyTo: input.messageIdHeader }, { references: input.messageIdHeader }]
      : []),
  ];
  if (links.length === 0) return threadId;

  const related = await collections.messages
    .find(
      {
        userId: input.userId,
        accountId: input.accountId,
        _id: { $ne: input.dedupeKey },
        $or: links,
      },
      { projection: { threadId: 1 } },
    )
    .toArray();
  const threadIds = [...new Set([threadId, ...related.map((message) => message.threadId)])].sort();
  if (threadIds.length === 1) return threadId;

  const [winner, ...losers] = threadIds as [string, ...string[]];
  await collections.messages.updateMany(
    { threadId: { $in: losers } },
    { $set: { threadId: winner } },
  );
  await Promise.all(losers.map((loser) => refreshThread(collections, loser)));
  return winner;
}

function participantsOf(docs: Pick<MessageDoc, 'from' | 'to' | 'cc'>[]): Address[] {
  const seen = new Map<string, Address>();
  for (const doc of docs) {
    for (const address of [doc.from, ...doc.to, ...doc.cc]) {
      if (address && !seen.has(address.address)) seen.set(address.address, address);
    }
  }
  return [...seen.values()].slice(0, MAX_PARTICIPANTS);
}

// Recomputed from the messages every time, so retries and replays can never drift the counts.
export async function refreshThread({ messages, threads }: MailCollections, threadId: string) {
  const docs = await messages
    .find({ threadId })
    .sort({ receivedAt: 1 })
    .project<
      Pick<
        MessageDoc,
        | 'userId'
        | 'accountId'
        | 'subject'
        | 'from'
        | 'to'
        | 'cc'
        | 'isRead'
        | 'isStarred'
        | 'attachments'
        | 'snippet'
        | 'receivedAt'
      >
    >({
      userId: 1,
      accountId: 1,
      subject: 1,
      from: 1,
      to: 1,
      cc: 1,
      isRead: 1,
      isStarred: 1,
      attachments: 1,
      snippet: 1,
      receivedAt: 1,
    })
    .toArray();
  if (docs.length === 0) {
    await threads.deleteOne({ _id: threadId });
    return;
  }

  const first = docs[0]!;
  const last = docs.at(-1)!;
  const subject = docs.find((doc) => doc.subject)?.subject ?? '';
  const now = new Date();

  await threads.updateOne(
    { _id: threadId },
    {
      $set: {
        userId: first.userId,
        accountId: first.accountId,
        subject,
        normalizedSubject: normalizeSubject(subject),
        participants: participantsOf(docs),
        messageCount: docs.length,
        unreadCount: docs.filter((doc) => !doc.isRead).length,
        isStarred: docs.some((doc) => doc.isStarred),
        hasAttachments: docs.some((doc) => doc.attachments.some((a) => !a.inline)),
        snippet: last.snippet,
        lastFrom: last.from,
        lastMessageAt: last.receivedAt,
        updatedAt: now,
      },
      $setOnInsert: { createdAt: now },
    },
    { upsert: true },
  );
}
