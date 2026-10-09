import { randomUUID } from 'node:crypto';
import { z } from 'zod';

export const EVENT_TYPES = [
  'message.created',
  'message.classified',
  'action.awaiting_approval',
  'account.degraded',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export const domainEventSchema = z.object({
  eventId: z.uuid(),
  type: z.enum(EVENT_TYPES),
  userId: z.string().min(1),
  traceId: z.string().min(1),
  occurredAt: z.iso.datetime(),
  data: z.record(z.string(), z.unknown()),
});

export type DomainEvent = z.infer<typeof domainEventSchema>;

export function createDomainEvent(
  input: Pick<DomainEvent, 'type' | 'userId' | 'data'> & { traceId?: string },
  now: Date = new Date(),
): DomainEvent {
  return {
    eventId: randomUUID(),
    type: input.type,
    userId: input.userId,
    traceId: input.traceId ?? randomUUID(),
    occurredAt: now.toISOString(),
    data: input.data,
  };
}
