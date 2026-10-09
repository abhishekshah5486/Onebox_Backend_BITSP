import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createJobEnvelope, jobEnvelopeSchema } from './job-envelope';

const schema = jobEnvelopeSchema(z.object({ uid: z.number() }));
const now = new Date('2026-10-07T10:00:00.000Z');

describe('createJobEnvelope', () => {
  it('builds a valid envelope with attempt 1 and current schema version', () => {
    const envelope = createJobEnvelope(
      { jobId: 'dedupe-1', userId: 'u1', accountId: 'a1', traceId: 't1', payload: { uid: 7 } },
      now,
    );

    expect(envelope).toEqual({
      jobId: 'dedupe-1',
      userId: 'u1',
      accountId: 'a1',
      traceId: 't1',
      attempt: 1,
      enqueuedAt: '2026-10-07T10:00:00.000Z',
      schemaVersion: 1,
      payload: { uid: 7 },
    });
    expect(schema.parse(envelope)).toEqual(envelope);
  });

  it('generates a traceId when none is propagated', () => {
    const envelope = createJobEnvelope({ jobId: 'j', userId: 'u', payload: { uid: 1 } });
    expect(envelope.traceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(envelope).not.toHaveProperty('accountId');
  });
});

describe('jobEnvelopeSchema', () => {
  const valid = createJobEnvelope({ jobId: 'j', userId: 'u', payload: { uid: 1 } }, now);

  it('rejects an invalid payload', () => {
    expect(schema.safeParse({ ...valid, payload: { uid: 'x' } }).success).toBe(false);
  });

  it('rejects an unknown schema version', () => {
    expect(schema.safeParse({ ...valid, schemaVersion: 2 }).success).toBe(false);
  });

  it('rejects a missing userId', () => {
    expect(schema.safeParse({ ...valid, userId: '' }).success).toBe(false);
  });
});
