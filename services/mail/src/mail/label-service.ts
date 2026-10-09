import { randomUUID } from 'node:crypto';
import { createJobEnvelope, type LabelOpPayload, type MailboxOpPayload } from '@onebox/contracts';
import { ConflictError, NotFoundError, ValidationError } from '@onebox/errors';
import type { Logger } from '@onebox/logger';
import type { MailboxStore } from '@onebox/mailbox-state';
import type { Producer } from '@onebox/queue';

const RESERVED = /^(inbox|\[gmail\]|\[google mail\])(\/|$)/i;

export function checkLabelName(raw: string): string {
  const name = raw.trim().replace(/\s*\/\s*/g, '/');
  if (!name || name.length > 200) throw new ValidationError('Label names need 1 to 200 characters');
  if (name.startsWith('/') || name.endsWith('/') || name.includes('//')) {
    throw new ValidationError('Use "/" only between nested label names, like Work/Clients');
  }
  if (RESERVED.test(name)) throw new ValidationError(`"${name}" is reserved by the mail server`);
  return name;
}

// Label changes run on the mail server through the connector; the request waits for the answer
// so a refusal (a duplicate name, a non-empty folder) reaches the user straight away.
export function createLabelService({
  store,
  ops,
  logger,
  waitMs = 20_000,
}: {
  store: MailboxStore;
  ops: Producer<MailboxOpPayload>;
  logger: Logger;
  waitMs?: number;
}) {
  async function assertOwner(userId: string, accountId: string) {
    const inbox = await store.getCounts(accountId, 'inbox');
    if (!inbox || inbox.userId !== userId) throw new NotFoundError('Mailbox not found');
  }

  async function run(userId: string, accountId: string, op: LabelOpPayload['op']) {
    await assertOwner(userId, accountId);
    const jobId = randomUUID();
    await ops.enqueue(
      createJobEnvelope<MailboxOpPayload>({
        jobId,
        userId,
        accountId,
        payload: { kind: 'label', op },
      }),
    );
    const outcome = await ops.outcome(jobId, { timeoutMs: waitMs });
    if (outcome.status === 'failed') throw new ValidationError(outcome.error);
    if (outcome.status === 'pending') {
      throw new ConflictError('The mail server is slow to answer; the change will show shortly.', {
        code: 'LABEL_PENDING',
      });
    }
    logger.info({ accountId, op: op.type }, 'label change applied');
    return { items: await store.getLabels(accountId) };
  }

  return {
    create: (userId: string, accountId: string, name: string) =>
      run(userId, accountId, { type: 'create', name: checkLabelName(name) }),
    rename: (userId: string, accountId: string, path: string, name: string) =>
      run(userId, accountId, { type: 'rename', path, name: checkLabelName(name) }),
    remove: (userId: string, accountId: string, path: string) =>
      run(userId, accountId, { type: 'delete', path }),
  };
}

export type LabelService = ReturnType<typeof createLabelService>;
