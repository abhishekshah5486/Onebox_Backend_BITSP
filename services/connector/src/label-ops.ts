import type { LabelOpPayload, MailboxChangePayload } from '@onebox/contracts';
import { ValidationError } from '@onebox/errors';
import type { Logger } from '@onebox/logger';
import type { MailboxStore } from '@onebox/mailbox-state';
import type { ImapFlow } from 'imapflow';
import { discoverFolders } from './folders';
import { isGmail } from './gmail';

// Creates, renames or deletes a label, then republishes the label list so OneBox shows it at once.
export async function runLabelOp(
  client: ImapFlow,
  {
    accountId,
    payload,
    store,
    emit,
    logger,
  }: {
    accountId: string;
    payload: LabelOpPayload;
    store: MailboxStore;
    emit: (change: MailboxChangePayload) => Promise<unknown>;
    logger: Logger;
  },
) {
  const { op } = payload;
  const entries = await client.list();
  const exists = (path: string) => entries.some((entry) => entry.path === path);

  if (op.type === 'create') {
    if (exists(op.name)) throw new ValidationError(`A label called ${op.name} already exists`);
    await client.mailboxCreate(op.name);
  } else if (op.type === 'rename') {
    if (!exists(op.path)) throw new ValidationError(`Label ${op.path} no longer exists`);
    if (exists(op.name)) throw new ValidationError(`A label called ${op.name} already exists`);
    await client.mailboxRename(op.path, op.name);
    await emit({ type: 'folderRenamed', folder: op.path, to: op.name });
  } else {
    if (!exists(op.path)) throw new ValidationError(`Label ${op.path} no longer exists`);
    // Gmail keeps the mail when a label goes; other servers delete the folder's mail with it.
    if (!isGmail(client)) {
      const status = await client.status(op.path, { messages: true });
      if (status && (status.messages ?? 0) > 0) {
        throw new ValidationError(
          'This provider deletes the mail inside a folder along with it. Move the mail out first.',
        );
      }
    }
    await client.mailboxDelete(op.path);
    await emit({ type: 'folderGone', folder: op.path });
  }

  const { labels } = discoverFolders(await client.list());
  await store.setLabels(
    accountId,
    labels.map(({ path, name }) => ({ path, name })),
  );
  logger.info({ accountId, op: op.type }, 'label changed');
}
