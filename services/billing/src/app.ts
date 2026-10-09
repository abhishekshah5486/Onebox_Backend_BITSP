import { requireUser, type TokenVerifier } from '@onebox/auth-kit';
import { createServer, registerHealthRoutes } from '@onebox/http';
import type { Logger } from '@onebox/logger';
import type { Credits } from './credits/credits';
import { registerBillingRoutes, registerInternalRoutes } from './routes';

export interface AppDeps {
  logger: Logger;
  pingDatabase: () => Promise<void>;
  routes?: { credits: Credits; verifyToken: TokenVerifier; internalToken: string };
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
        registerBillingRoutes(scope, routes.credits);
      },
      { prefix: '/billing' },
    );
    void app.register(
      async (scope) => registerInternalRoutes(scope, routes.credits, routes.internalToken),
      { prefix: '/internal/billing' },
    );
  }
  return app;
}
