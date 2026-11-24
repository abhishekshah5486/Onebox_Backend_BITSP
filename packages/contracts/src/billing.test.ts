import { describe, expect, it } from 'vitest';
import { paymentEventPayloadSchema, periodPrice } from './billing';

describe('billing contracts', () => {
  it('prices a month, or a year paid up front', () => {
    expect(periodPrice('STANDARD', 'monthly')).toBe(49_900);
    expect(periodPrice('STANDARD', 'annual')).toBe(41_500 * 12);
    expect(periodPrice('FREE', 'annual')).toBe(0);
  });

  it('accepts a payment event without provider details', () => {
    expect(
      paymentEventPayloadSchema.parse({
        type: 'subscription.renewed',
        subscriptionId: '1b4e28ba-2fa1-41d2-883f-0016d3cca427',
        plan: 'PRO',
        interval: 'monthly',
        periodStart: '2026-10-09T00:00:00.000Z',
        periodEnd: '2026-11-09T00:00:00.000Z',
        paymentId: 'pay_123',
        occurredAt: '2026-10-09T00:00:01.000Z',
      }),
    ).toMatchObject({ plan: 'PRO' });
  });
});
