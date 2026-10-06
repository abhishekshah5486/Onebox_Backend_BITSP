import { describe, expect, it } from 'vitest';
import { createDomainEvent, domainEventSchema } from './domain-event';

describe('createDomainEvent', () => {
  it('builds a schema-valid event with a fresh eventId', () => {
    const now = new Date('2026-10-07T10:00:00.000Z');
    const event = createDomainEvent(
      { type: 'message.created', userId: 'u1', traceId: 't1', data: { messageId: 'm1' } },
      now,
    );

    expect(domainEventSchema.parse(event)).toEqual(event);
    expect(event).toMatchObject({ traceId: 't1', occurredAt: '2026-10-07T10:00:00.000Z' });
  });

  it('gives each event a unique id', () => {
    const input = { type: 'account.degraded', userId: 'u1', data: {} } as const;
    expect(createDomainEvent(input).eventId).not.toBe(createDomainEvent(input).eventId);
  });
});

describe('domainEventSchema', () => {
  it('rejects unknown event types', () => {
    const event = createDomainEvent({ type: 'message.created', userId: 'u1', data: {} });
    expect(domainEventSchema.safeParse({ ...event, type: 'message.deleted' }).success).toBe(false);
  });
});
