import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { RazorpayWebhooks } from './razorpay-webhooks';
import type { StripeWebhooks } from './stripe-webhooks';

export interface Webhooks {
  razorpay: RazorpayWebhooks | null;
  stripe: StripeWebhooks | null;
}

const header = (request: FastifyRequest, name: string) => {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
};

// Public: providers call these, and every request is checked by its signature.
export function registerWebhookRoutes(scope: FastifyInstance, webhooks: Webhooks) {
  // The signature covers the exact bytes sent, so the body is kept as text.
  scope.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) =>
    done(null, body),
  );
  const notConfigured = { error: { code: 'NOT_CONFIGURED' } };

  scope.post('/razorpay', async (request, reply) => {
    if (!webhooks.razorpay) return reply.status(503).send(notConfigured);
    await webhooks.razorpay.receive(
      request.body as string,
      header(request, 'x-razorpay-signature'),
      header(request, 'x-razorpay-event-id'),
    );
    return reply.status(200).send({ ok: true });
  });

  scope.post('/stripe', async (request, reply) => {
    if (!webhooks.stripe) return reply.status(503).send(notConfigured);
    await webhooks.stripe.receive(request.body as string, header(request, 'stripe-signature'));
    return reply.status(200).send({ ok: true });
  });
}
