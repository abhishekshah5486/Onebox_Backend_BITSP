import type { TokenVerifier } from '@onebox/auth-kit';
import { createServer, registerHealthRoutes } from '@onebox/http';
import type { Logger } from '@onebox/logger';
import type { AccountService } from './accounts/account-service';
import { registerAccountRoutes } from './accounts/routes';

export interface AppDeps {
  logger: Logger;
  pingDatabase: () => Promise<void>;
  routes?: { accounts: AccountService; verifyToken: TokenVerifier };
}

export function buildApp(deps: AppDeps) {
  const app = createServer({ logger: deps.logger });
  registerHealthRoutes(app, { postgres: deps.pingDatabase });
  if (deps.routes) registerAccountRoutes(app, deps.routes);
  return app;
}
