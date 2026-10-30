import type { LiveEvent } from '@onebox/contracts';
import type { Logger } from '@onebox/logger';
import type { ChangeStream, ChangeStreamDocument, Collection, Db } from 'mongodb';
import type { ThreadDoc } from '../db/collections';

const RESTART_DELAY_MS = 5_000;

// A deleted conversation's change event only names its id; the pre-image says whose it was.
export async function enableThreadPreImages(db: Db) {
  await db.command({ collMod: 'threads', changeStreamPreAndPostImages: { enabled: true } });
}

export function liveEventOf(change: ChangeStreamDocument<ThreadDoc>) {
  if (change.operationType === 'delete') {
    const before = change.fullDocumentBeforeChange;
    if (!before) return null;
    return {
      userId: before.userId,
      event: { type: 'thread.removed', threadId: before._id } satisfies LiveEvent,
    };
  }
  if (
    change.operationType === 'insert' ||
    change.operationType === 'update' ||
    change.operationType === 'replace'
  ) {
    const before = 'fullDocumentBeforeChange' in change ? change.fullDocumentBeforeChange : null;
    const doc = change.fullDocument ?? before;
    if (!doc) return null;
    return {
      userId: doc.userId,
      event: {
        type: 'thread.changed',
        threadId: doc._id,
        accountId: doc.accountId,
      } satisfies LiveEvent,
    };
  }
  return null;
}

// Tells each user's open apps about every change to their conversations, whatever made it:
// new mail, a sync from the server, an action in another window, or AI labelling.
export function startLiveFeed({
  threads,
  publish,
  logger,
}: {
  threads: Collection<ThreadDoc>;
  publish: (userId: string, event: LiveEvent) => Promise<unknown>;
  logger: Logger;
}) {
  let stream: ChangeStream<ThreadDoc> | null = null;
  let closed = false;
  let timer: NodeJS.Timeout | undefined;

  const open = () => {
    stream = threads.watch(
      [{ $match: { operationType: { $in: ['insert', 'update', 'replace', 'delete'] } } }],
      { fullDocument: 'updateLookup', fullDocumentBeforeChange: 'whenAvailable' },
    );
    stream.on('change', (change: ChangeStreamDocument<ThreadDoc>) => {
      const live = liveEventOf(change);
      if (!live) return;
      publish(live.userId, live.event).catch((err: unknown) =>
        logger.warn({ err: (err as Error).message }, 'live event not published'),
      );
    });
    stream.on('error', (err) => {
      logger.warn({ err: err.message }, 'live feed interrupted, reopening');
      void stream?.close();
      if (!closed) timer = setTimeout(open, RESTART_DELAY_MS);
    });
    logger.info('live feed started');
  };
  open();

  return {
    close: async () => {
      closed = true;
      clearTimeout(timer);
      await stream?.close();
    },
  };
}
