import type { TokenVerifier } from '@onebox/auth-kit';
import { createServer, registerHealthRoutes, type HealthCheck } from '@onebox/http';
import type { Logger } from '@onebox/logger';
import type { Catalog } from './llm/catalog';
import type { Completer } from './llm/complete';
import { registerLlmRoutes } from './llm/routes';
import type { Usage } from './llm/usage';

export interface AppDeps {
  logger: Logger;
  checks: Record<string, HealthCheck>;
  routes?: {
    catalog: Catalog;
    complete: Completer;
    usage: Usage;
    verifyToken: TokenVerifier;
    internalToken: string;
  };
}

export function buildApp(deps: AppDeps) {
  const app = createServer({ logger: deps.logger });
  registerHealthRoutes(app, deps.checks);
  if (deps.routes) registerLlmRoutes(app, deps.routes);
  return app;
}
