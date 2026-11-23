import { describe, expect, it } from 'vitest';
import { loadPaymentsConfig, razorpayKeys, stripeKey } from './config';

const base = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  CREDENTIALS_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
};

describe('payments config', () => {
  it('uses the test keys unless live mode is chosen', () => {
    const config = loadPaymentsConfig({
      ...base,
      RAZORPAY_TEST_API_KEY: 'rzp_test_abc',
      RAZORPAY_TEST_KEY_SECRET: 'secret',
      RAZORPAY_LIVE_API_KEY: 'rzp_live_xyz',
      RAZORPAY_LIVE_KEY_SECRET: 'live-secret',
    });
    expect(config.PORT).toBe(4008);
    expect(razorpayKeys(config)).toEqual({ keyId: 'rzp_test_abc', keySecret: 'secret' });
    expect(razorpayKeys({ ...config, PAYMENTS_MODE: 'live' })).toEqual({
      keyId: 'rzp_live_xyz',
      keySecret: 'live-secret',
    });
  });

  it('turns Razorpay off without keys, and rejects a live key used as a test key', () => {
    expect(razorpayKeys(loadPaymentsConfig(base))).toBeNull();
    expect(() => loadPaymentsConfig({ ...base, RAZORPAY_TEST_API_KEY: 'rzp_live_oops' })).toThrow(
      /RAZORPAY_TEST_API_KEY/,
    );
  });

  it('picks the Stripe key for the mode', () => {
    const config = loadPaymentsConfig({
      ...base,
      STRIPE_TEST_SECRET_KEY: 'sk_test_abc',
      STRIPE_LIVE_SECRET_KEY: 'sk_live_xyz',
    });
    expect(stripeKey(config)).toBe('sk_test_abc');
    expect(stripeKey({ ...config, PAYMENTS_MODE: 'live' })).toBe('sk_live_xyz');
    expect(stripeKey(loadPaymentsConfig(base))).toBeNull();
  });
});
