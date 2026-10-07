import { requireUser, type TokenVerifier } from '@onebox/auth-kit';
import { createServer, registerHealthRoutes } from '@onebox/http';
import type { Logger } from '@onebox/logger';
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
        registerPreferenceRoutes(scope, routes.preferences);
        registerIntegrationRoutes(scope, routes.integrations);
      },
      { prefix: '/settings' },
    );
  }
  return app;
}
