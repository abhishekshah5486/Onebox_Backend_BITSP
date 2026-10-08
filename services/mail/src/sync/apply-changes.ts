import {
  decodeUidSet,
  ingestDedupeKey,
  MAIL_CATEGORIES,
  tabOf,
  type MailCategory,
  type JobEnvelope,
  type MailboxChangePayload,
} from '@onebox/contracts';
import { isDuplicateKeyError } from '@onebox/db-mongo';
import { ValidationError } from '@onebox/errors';
import type { JobContext } from '@onebox/queue';
import type { AnyBulkWriteOperation, Filter } from 'mongodb';
import type { MailCollections, MessageDoc } from '../db/collections';
import { refreshThread } from '../threads/thread-store';

// A change made in OneBox gets this long to reach the server before a sync may override it.
export const PENDING_GRACE_MS = 10 * 60_000;

const flagState = (flags: string[]) => ({
  flags,
  isRead: flags.includes('\\Seen'),
  isStarred: flags.includes('\\Flagged'),
});

export function createChangesHandler(collections: MailCollections) {
  const { messages } = collections;

  return async (envelope: JobEnvelope<MailboxChangePayload>, { logger }: JobContext) => {
    const { accountId, payload: change } = envelope;
    if (!accountId) throw new ValidationError('Mailbox change is missing accountId');
    const at = (uids: number[]): Filter<MessageDoc> => ({
      accountId,
      folder: change.folder,
      ...('uidValidity' in change && { uidValidity: change.uidValidity }),
      uid: { $in: uids },
    });
    const settled = (doc: Pick<MessageDoc, 'pendingSince'>) =>
      !doc.pendingSince || Date.now() - doc.pendingSince.getTime() > PENDING_GRACE_MS;
    const touched = new Set<string>();
    const threadsOf = async (filter: Filter<MessageDoc>) => {
      for (const doc of await messages.find(filter, { projection: { threadId: 1 } }).toArray()) {
        touched.add(doc.threadId);
      }
    };

    switch (change.type) {
      case 'moved': {
        const { to } = change;
        const sources = await messages.find(at(change.uidMap.map(([from]) => from))).toArray();
        const byUid = new Map(sources.map((doc) => [doc.uid, doc]));
        for (const [from, uid] of change.uidMap) {
          const doc = byUid.get(from);
          if (!doc) continue;
          touched.add(doc.threadId);
          try {
            await messages.insertOne({
              ...doc,
              _id: ingestDedupeKey({
                accountId,
                folder: to.folder,
                uidValidity: to.uidValidity,
                uid,
              }),
              folder: to.folder,
              role: to.role,
              uid,
              uidValidity: to.uidValidity,
              category: to.role === 'inbox' ? tabOf(doc.categories ?? []) : null,
              pendingSince: null,
              movingTo: null,
            });
          } catch (err) {
            // The destination's own sync already stored it.
            if (!isDuplicateKeyError(err)) throw err;
          }
        }
        const moved = sources.map((doc) => doc._id);
        if (change.keepSource) {
          await messages.updateMany(
            { _id: { $in: moved } },
            { $set: { pendingSince: null, movingTo: null } },
          );
        } else {
          await messages.deleteMany({ _id: { $in: moved } });
        }
        break;
      }

      // Stored copies take the label's new path, keyed as the destination's own sync would key them.
      case 'folderRenamed': {
        const docs = await messages.find({ accountId, folder: change.folder }).toArray();
        for (const doc of docs) {
          touched.add(doc.threadId);
          try {
            await messages.insertOne({
              ...doc,
              _id: ingestDedupeKey({
                accountId,
                folder: change.to,
                uidValidity: doc.uidValidity,
                uid: doc.uid,
              }),
              folder: change.to,
            });
          } catch (err) {
            if (!isDuplicateKeyError(err)) throw err;
          }
        }
        await messages.deleteMany({ _id: { $in: docs.map((doc) => doc._id) } });
        await messages.updateMany(
          { accountId, 'movingTo.folder': change.folder },
          { $set: { 'movingTo.folder': change.to } },
        );
        break;
      }

      case 'folderGone': {
        const gone = { accountId, folder: change.folder };
        await threadsOf(gone);
        await messages.deleteMany(gone);
        break;
      }

      case 'removed':
        await threadsOf(at(change.uids));
        await messages.deleteMany(at(change.uids));
        break;

      case 'settled':
        await threadsOf(at(change.uids));
        await messages.updateMany(at(change.uids), {
          $set: { pendingSince: null, movingTo: null },
        });
        break;

      case 'flags': {
        const docs = await messages.find(at(change.flags.map((f) => f.uid))).toArray();
        const flagsOf = new Map(change.flags.map((f) => [f.uid, f.flags]));
        const writes: AnyBulkWriteOperation<MessageDoc>[] = docs.filter(settled).map((doc) => {
          touched.add(doc.threadId);
          return {
            updateOne: {
              filter: { _id: doc._id },
              update: { $set: flagState(flagsOf.get(doc.uid)!) },
            },
          };
        });
        if (writes.length) await messages.bulkWrite(writes);
        break;
      }

      case 'snapshot': {
        const present = decodeUidSet(change.present);
        const flagsOf = new Map(change.flags.map((f) => [f.uid, f.flags]));
        const tagsOf = new Map<number, MailCategory[]>();
        for (const tag of MAIL_CATEGORIES) {
          for (const uid of decodeUidSet(change.categories?.[tag] ?? '')) {
            tagsOf.set(uid, [...(tagsOf.get(uid) ?? []), tag]);
          }
        }
        const writes: AnyBulkWriteOperation<MessageDoc>[] = [];
        // A renumbered folder is re-fetched from scratch by the connector.
        const renumbered = {
          accountId,
          folder: change.folder,
          uidValidity: { $ne: change.uidValidity },
        };
        await threadsOf(renumbered);
        writes.push({ deleteMany: { filter: renumbered } });

        const stored = messages.find(
          {
            accountId,
            folder: change.folder,
            uidValidity: change.uidValidity,
            uid: { $lt: change.uidNext },
          },
          {
            projection: {
              uid: 1,
              threadId: 1,
              pendingSince: 1,
              isRead: 1,
              isStarred: 1,
              category: 1,
              movingTo: 1,
            },
          },
        );
        for await (const doc of stored) {
          if (!settled(doc)) continue;
          const set: Partial<MessageDoc> = {};
          if (!present.has(doc.uid)) {
            writes.push({ deleteOne: { filter: { _id: doc._id } } });
            touched.add(doc.threadId);
            continue;
          }
          if (doc.pendingSince || doc.movingTo)
            Object.assign(set, { pendingSince: null, movingTo: null });
          const flags = flagsOf.get(doc.uid);
          if (flags) {
            const next = flagState(flags);
            if (next.isRead !== doc.isRead || next.isStarred !== doc.isStarred)
              Object.assign(set, next);
          }
          if (change.categories) {
            const tags = tagsOf.get(doc.uid) ?? [];
            if (tags.join() !== (doc.categories ?? []).join()) set.categories = tags;
            const tab = change.role === 'inbox' ? tabOf(tags) : null;
            if (tab !== doc.category) set.category = tab;
          }
          if (Object.keys(set).length > 0) {
            writes.push({ updateOne: { filter: { _id: doc._id }, update: { $set: set } } });
            touched.add(doc.threadId);
          }
        }
        await messages.bulkWrite(writes, { ordered: false });
        break;
      }
    }

    for (const threadId of touched) await refreshThread(collections, threadId);
    if (touched.size > 0) {
      logger.info(
        { accountId, change: change.type, folder: change.folder, conversations: touched.size },
        'mailbox change applied',
      );
    }
  };
}
