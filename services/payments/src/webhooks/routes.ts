import type { FastifyInstance } from 'fastify';
import type { RazorpayWebhooks } from './razorpay-webhooks';

// Public: providers call these, and every request is checked by its signature.
export function registerWebhookRoutes(scope: FastifyInstance, razorpay: RazorpayWebhooks | null) {
  // The signature covers the exact bytes sent, so the body is kept as text.
  scope.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) =>
    done(null, body),
  );

  scope.post('/razorpay', async (request, reply) => {
    if (!razorpay) return reply.status(503).send({ error: { code: 'NOT_CONFIGURED' } });
    const header = (name: string) => {
      const value = request.headers[name];
      return Array.isArray(value) ? value[0] : value;
    };
    await razorpay.receive(
      request.body as string,
      header('x-razorpay-signature'),
      header('x-razorpay-event-id'),
    );
    return reply.status(200).send({ ok: true });
  });
}
