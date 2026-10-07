import type { TokenVerifier } from '@onebox/auth-kit';
import { createServer, registerHealthRoutes, type HealthCheck } from '@onebox/http';
import type { Logger } from '@onebox/logger';
import type { MailService } from './mail/mail-service';
import type { MailboxService } from './mail/mailbox-service';
import { registerMailRoutes } from './mail/routes';

export interface AppDeps {
  logger: Logger;
  checks: Record<string, HealthCheck>;
  routes?: { mail: MailService; mailboxes: MailboxService; verifyToken: TokenVerifier };
}

export function buildApp(deps: AppDeps) {
  const app = createServer({ logger: deps.logger });
  registerHealthRoutes(app, deps.checks);
  if (deps.routes) registerMailRoutes(app, deps.routes);
  return app;
}
