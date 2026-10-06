import { createServer, registerHealthRoutes } from '@onebox/http';
import type { Logger } from '@onebox/logger';

export interface AppDeps {
  logger: Logger;
  pingDatabase: () => Promise<void>;
}

export function buildApp(deps: AppDeps) {
  const app = createServer({ logger: deps.logger });
  registerHealthRoutes(app, { postgres: deps.pingDatabase });
  return app;
}
