import { requireInternal, requireUser, type TokenVerifier } from '@onebox/auth-kit';
import { createServer, registerHealthRoutes } from '@onebox/http';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Logger } from '@onebox/logger';
import type { GoogleService } from './google/google-service';
import { registerGoogleCallback, registerGoogleRoutes } from './google/routes';
import type { IntegrationService } from './integrations/integration-service';
import { registerIntegrationRoutes } from './integrations/routes';
import type { PreferencesService } from './preferences/preferences-service';
import { registerPreferenceRoutes } from './preferences/routes';

export interface AppDeps {
  logger: Logger;
  pingDatabase: () => Promise<void>;
  routes?: {
    preferences: PreferencesService;
    integrations: IntegrationService;
    google: GoogleService;
    verifyToken: TokenVerifier;
    internalToken: string;
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
        registerPreferenceRoutes(scope, routes.preferences);
        registerIntegrationRoutes(scope, routes.integrations);
        registerGoogleRoutes(scope, routes.google);
      },
      { prefix: '/settings' },
    );
    // Never routed by the gateway; the connector reads a user's preferences here.
    app.get<{ Params: { userId: string } }>(
      '/internal/preferences/:userId',
      { preHandler: requireInternal(routes.internalToken) },
      async (request) => routes.preferences.get(request.params.userId),
    );
    // The mail service fetches Drive access tokens here.
    app.withTypeProvider<ZodTypeProvider>().get(
      '/internal/google/token/:userId/:accountId',
      {
        preHandler: requireInternal(routes.internalToken),
        schema: { params: z.object({ userId: z.uuid(), accountId: z.uuid() }) },
      },
      async (request) => ({
        accessToken: await routes.google.accessToken(
          request.params.userId,
          request.params.accountId,
        ),
      }),
    );
    registerGoogleCallback(app, routes.google);
  }
  return app;
}
