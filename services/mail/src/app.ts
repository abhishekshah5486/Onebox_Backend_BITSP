import type { TokenVerifier } from '@onebox/auth-kit';
import { createServer, registerHealthRoutes, type HealthCheck } from '@onebox/http';
import type { Logger } from '@onebox/logger';
import type { AttachmentService } from './attachments/attachments';
import type { ComposeService } from './compose/compose-service';
import { registerComposeRoutes } from './compose/routes';
import type { StorageService } from './storage/storage';
import type { LabelService } from './mail/label-service';
import type { MailService } from './mail/mail-service';
import type { MailboxService } from './mail/mailbox-service';
import { registerInternalMailRoutes } from './mail/internal-routes';
import { registerMailRoutes } from './mail/routes';
import type { ThreadActions } from './mail/thread-actions';

export interface AppDeps {
  logger: Logger;
  checks: Record<string, HealthCheck>;
  routes?: {
    mail: MailService;
    mailboxes: MailboxService;
    actions: ThreadActions;
    labels: LabelService;
    attachments?: AttachmentService;
    storage?: StorageService;
    compose?: ComposeService;
    verifyToken: TokenVerifier;
  };
  // Stored mail for other services (RAG), behind the internal token.
  internal?: Parameters<typeof registerInternalMailRoutes>[1];
}

export function buildApp(deps: AppDeps) {
  const app = createServer({ logger: deps.logger });
  registerHealthRoutes(app, deps.checks);
  if (deps.routes) registerMailRoutes(app, deps.routes);
  if (deps.internal) registerInternalMailRoutes(app, deps.internal);
  if (deps.routes?.compose) {
    registerComposeRoutes(app, {
      compose: deps.routes.compose,
      storage: deps.routes.storage,
      verifyToken: deps.routes.verifyToken,
    });
  }
  return app;
}
