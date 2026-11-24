import { createServer, registerHealthRoutes, type HealthCheck } from '@onebox/http';
import type { Logger } from '@onebox/logger';
import { registerLlmRoutes } from './llm/routes';

export interface AppDeps {
  logger: Logger;
  checks: Record<string, HealthCheck>;
  routes?: Parameters<typeof registerLlmRoutes>[1];
}

export function buildApp(deps: AppDeps) {
  const app = createServer({ logger: deps.logger });
  registerHealthRoutes(app, deps.checks);
  if (deps.routes) registerLlmRoutes(app, deps.routes);
  return app;
}
