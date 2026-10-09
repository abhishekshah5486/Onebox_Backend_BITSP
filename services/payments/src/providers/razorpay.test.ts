import { createHmac } from 'node:crypto';
import { createLogger } from '@onebox/logger';
import { describe, expect, it } from 'vitest';
import { createRazorpay } from './razorpay';

const logger = createLogger({ service: 'test', level: 'silent' });
const keys = { keyId: 'rzp_test_abc', keySecret: 'secret', webhookSecret: 'hook-secret' };
const sign = (secret: string, body: string) =>
  createHmac('sha256', secret).update(body).digest('hex');

describe('razorpay', () => {
  it('calls the API with the key and returns what it made', async () => {
    const calls: { url: string; auth: string | null; body: unknown }[] = [];
    const send: typeof fetch = async (input, init) => {
      calls.push({
        url: input as string,
        auth: new Headers(init?.headers).get('authorization'),
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      });
      return new Response(JSON.stringify({ id: 'plan_1' }));
    };
    const razorpay = createRazorpay(keys, logger, send);
    const id = await razorpay.createPlan({
      name: 'Standard',
      description: 'OneBox Standard, monthly',
      amount: 49_900,
      currency: 'INR',
      period: 'monthly',
    });
    expect(id).toBe('plan_1');
    expect(calls[0]).toMatchObject({
      url: 'https://api.razorpay.com/v1/plans',
      auth: `Basic ${Buffer.from('rzp_test_abc:secret').toString('base64')}`,
      body: { period: 'monthly', interval: 1, item: { amount: 49_900, currency: 'INR' } },
    });
  });

  it("passes on Razorpay's reason when it refuses", async () => {
    const send: typeof fetch = async () =>
      new Response(
        JSON.stringify({ error: { code: 'BAD_REQUEST_ERROR', description: 'Invalid plan' } }),
        { status: 400 },
      );
    await expect(createRazorpay(keys, logger, send).fetchSubscription('sub_1')).rejects.toThrow(
      'Invalid plan',
    );
  });

  it('says so when the account has no Subscriptions product', async () => {
    const send: typeof fetch = async () =>
      new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
    const failure = createRazorpay(keys, logger, send).fetchSubscription('sub_1');
    await expect(failure).rejects.toMatchObject({ statusCode: 503, code: 'PROVIDER_UNAVAILABLE' });
    await expect(failure).rejects.toThrow(/subscriptions aren't turned on/);
  });

  it('moves a subscription to another plan straight away', async () => {
    let sent: { method?: string; url: string; body: unknown } | undefined;
    const send: typeof fetch = async (input, init) => {
      sent = { method: init?.method, url: input as string, body: JSON.parse(init!.body as string) };
      return new Response(JSON.stringify({ id: 'sub_1', status: 'active' }));
    };
    await createRazorpay(keys, logger, send).changePlan('sub_1', 'plan_pro');
    expect(sent).toEqual({
      method: 'PATCH',
      url: 'https://api.razorpay.com/v1/subscriptions/sub_1',
      body: { plan_id: 'plan_pro', schedule_change_at: 'now', customer_notify: 1 },
    });
  });

  it('accepts only checkout results signed with the key secret', () => {
    const razorpay = createRazorpay(keys, logger);
    const signature = sign('secret', 'pay_1|sub_1');
    expect(
      razorpay.verifyCheckout({ paymentId: 'pay_1', subscriptionId: 'sub_1', signature }),
    ).toBe(true);
    expect(
      razorpay.verifyCheckout({ paymentId: 'pay_2', subscriptionId: 'sub_1', signature }),
    ).toBe(false);
  });

  it('accepts only webhooks signed with the webhook secret over the raw body', () => {
    const razorpay = createRazorpay(keys, logger);
    const body = '{"event":"subscription.charged"}';
    expect(razorpay.verifyWebhook(body, sign('hook-secret', body))).toBe(true);
    expect(razorpay.verifyWebhook(body + ' ', sign('hook-secret', body))).toBe(false);
    expect(
      createRazorpay({ ...keys, webhookSecret: undefined }, logger).verifyWebhook(body, 'x'),
    ).toBe(false);
  });
});
