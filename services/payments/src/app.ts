import { requireUser, type TokenVerifier } from '@onebox/auth-kit';
import { createServer, registerHealthRoutes } from '@onebox/http';
import type { Logger } from '@onebox/logger';
import type { CheckoutService } from './checkout/checkout-service';
import { registerCheckoutRoutes } from './checkout/routes';
import type { RazorpayWebhooks } from './webhooks/razorpay-webhooks';
import { registerWebhookRoutes } from './webhooks/routes';

export interface AppDeps {
  logger: Logger;
  pingDatabase: () => Promise<void>;
  routes?: {
    checkout: CheckoutService;
    razorpayWebhooks: RazorpayWebhooks | null;
    verifyToken: TokenVerifier;
  };
}

export function buildApp(deps: AppDeps) {
  const app = createServer({ logger: deps.logger });
  registerHealthRoutes(app, { postgres: deps.pingDatabase });

  const routes = deps.routes;
  if (routes) {
    app.decorateRequest('user', null);
    void app.register(
      async (scope) => {
        scope.addHook('preHandler', requireUser(routes.verifyToken));
        registerCheckoutRoutes(scope, routes.checkout);
      },
      { prefix: '/payments' },
    );
    void app.register(async (scope) => registerWebhookRoutes(scope, routes.razorpayWebhooks), {
      prefix: '/webhooks',
    });
  }
  return app;
}
