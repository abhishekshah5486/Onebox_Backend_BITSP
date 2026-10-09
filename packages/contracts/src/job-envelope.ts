import { randomUUID } from 'node:crypto';
import { z } from 'zod';

export const QUEUES = {
  ingest: 'ingest',
  history: 'history',
  mailboxOps: 'mailbox-ops',
  mailboxChanges: 'mailbox-changes',
  ai: 'ai',
  index: 'index',
  embed: 'embed',
  rules: 'rules',
  action: 'action',
  payments: 'payments',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export const JOB_SCHEMA_VERSION = 1;

export function jobEnvelopeSchema<P extends z.ZodType>(payload: P) {
  return z.object({
    jobId: z.string().min(1),
    userId: z.string().min(1),
    accountId: z.string().min(1).optional(),
    traceId: z.string().min(1),
    attempt: z.number().int().min(1),
    enqueuedAt: z.iso.datetime(),
    schemaVersion: z.literal(JOB_SCHEMA_VERSION),
    payload,
  });
}

export type JobEnvelope<P> = Omit<z.infer<ReturnType<typeof jobEnvelopeSchema>>, 'payload'> & {
  payload: P;
};

export interface CreateJobEnvelopeInput<P> {
  jobId: string;
  userId: string;
  accountId?: string;
  traceId?: string;
  payload: P;
}

// jobId must be deterministic (e.g. the dedupe key) so a re-enqueue is a no-op.
export function createJobEnvelope<P>(
  input: CreateJobEnvelopeInput<P>,
  now: Date = new Date(),
): JobEnvelope<P> {
  return {
    jobId: input.jobId,
    userId: input.userId,
    ...(input.accountId !== undefined && { accountId: input.accountId }),
    traceId: input.traceId ?? randomUUID(),
    attempt: 1,
    enqueuedAt: now.toISOString(),
    schemaVersion: JOB_SCHEMA_VERSION,
    payload: input.payload,
  };
}
