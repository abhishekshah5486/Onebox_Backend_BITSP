import { createHmac } from 'node:crypto';
import { createLogger } from '@onebox/logger';
import { describe, expect, it } from 'vitest';
import { createStripe, periodOf } from './stripe';

const logger = createLogger({ service: 'test', level: 'silent' });

describe('stripe', () => {
  it('sends form-encoded requests with nested keys and the secret key', async () => {
    let request: { url: string; auth: string | null; body: string } | undefined;
    const send: typeof fetch = async (input, init) => {
      request = {
        url: input as string,
        auth: new Headers(init?.headers).get('authorization'),
        body: init?.body as string,
      };
      return new Response(JSON.stringify({ id: 'price_1' }));
    };
    const stripe = createStripe({ secretKey: 'sk_test_abc' }, logger, send);
    expect(
      await stripe.createPrice({
        name: 'OneBox Pro',
        amount: 149_900,
        currency: 'INR',
        interval: 'month',
      }),
    ).toBe('price_1');
    expect(request!.url).toBe('https://api.stripe.com/v1/prices');
    expect(request!.auth).toBe('Bearer sk_test_abc');
    const body = new URLSearchParams(request!.body);
    expect(body.get('recurring[interval]')).toBe('month');
    expect(body.get('product_data[name]')).toBe('OneBox Pro');
    expect(body.get('currency')).toBe('inr');
  });

  it('accepts only fresh webhooks signed with the webhook secret', () => {
    const stripe = createStripe({ secretKey: 'sk_test_abc', webhookSecret: 'whsec_test' }, logger);
    const body = '{"type":"invoice.paid"}';
    const now = 1_800_000_000_000;
    const t = now / 1000;
    const sig = createHmac('sha256', 'whsec_test').update(`${t}.${body}`).digest('hex');
    expect(stripe.verifyWebhook(body, `t=${t},v1=${sig}`, now)).toBe(true);
    expect(stripe.verifyWebhook(body + ' ', `t=${t},v1=${sig}`, now)).toBe(false);
    // Replayed ten minutes later.
    expect(stripe.verifyWebhook(body, `t=${t},v1=${sig}`, now + 600_000)).toBe(false);
  });

  it('reads the period from the subscription or, on newer API versions, its item', () => {
    expect(
      periodOf({ id: 's', status: 'active', cancel_at_period_end: false, current_period_end: 10 })
        .end,
    ).toEqual(new Date(10_000));
    expect(
      periodOf({
        id: 's',
        status: 'active',
        cancel_at_period_end: false,
        items: { data: [{ id: 'si_1', current_period_start: 1, current_period_end: 20 }] },
      }),
    ).toEqual({ start: new Date(1000), end: new Date(20_000) });
  });
});
