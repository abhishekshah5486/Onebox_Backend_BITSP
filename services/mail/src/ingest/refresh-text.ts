import type { MailCollections } from '../db/collections';
import { refreshThread } from '../threads/thread-store';
import { makeSnippet, readableText, TEXT_VERSION } from './parse';

// Mail stored under older text rules gets today's text and snippet, a batch at a time; the
// conversations whose snippet changed are refreshed too.
export async function refreshStoredText(collections: MailCollections, batchSize = 200) {
  let changed = 0;
  for (;;) {
    const batch = await collections.messages
      .find(
        { $or: [{ textVersion: { $exists: false } }, { textVersion: { $lt: TEXT_VERSION } }] },
        { projection: { textBody: 1, snippet: 1, threadId: 1 } },
      )
      .limit(batchSize)
      .toArray();
    if (batch.length === 0) return changed;
    const threads = new Set<string>();
    for (const doc of batch) {
      const textBody = readableText(doc.textBody ?? '');
      const snippet = makeSnippet(textBody || doc.snippet);
      const update =
        textBody === doc.textBody && snippet === doc.snippet
          ? { textVersion: TEXT_VERSION }
          : { textBody, snippet, textVersion: TEXT_VERSION };
      await collections.messages.updateOne({ _id: doc._id }, { $set: update });
      if (snippet !== doc.snippet) {
        threads.add(doc.threadId);
        changed += 1;
      }
    }
    for (const threadId of threads) await refreshThread(collections, threadId);
  }
}
