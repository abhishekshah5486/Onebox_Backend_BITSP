import type { TokenVerifier } from '@onebox/auth-kit';
import { createServer, registerHealthRoutes, type HealthCheck } from '@onebox/http';
import type { Logger } from '@onebox/logger';
import type { LabelRules } from './labels/label-rules';
import { registerAiRoutes } from './routes';
import type { Suggestions } from './suggestions/suggestions';

export interface AppDeps {
  logger: Logger;
  checks: Record<string, HealthCheck>;
  routes?: { labels: LabelRules; suggestions: Suggestions; verifyToken: TokenVerifier };
}

export function buildApp(deps: AppDeps) {
  const app = createServer({ logger: deps.logger });
  registerHealthRoutes(app, deps.checks);
  if (deps.routes) registerAiRoutes(app, deps.routes);
  return app;
}
