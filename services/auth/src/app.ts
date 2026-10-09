import { createServer, registerHealthRoutes } from '@onebox/http';
import type { Logger } from '@onebox/logger';
import { registerAuthRoutes, type AuthRouteDeps } from './routes';

export interface AppDeps {
  logger: Logger;
  pingDatabase: () => Promise<void>;
  routes?: AuthRouteDeps;
}

export function buildApp(deps: AppDeps) {
  const app = createServer({ logger: deps.logger });
  registerHealthRoutes(app, { postgres: deps.pingDatabase });
  if (deps.routes) registerAuthRoutes(app, deps.routes);
  return app;
}
