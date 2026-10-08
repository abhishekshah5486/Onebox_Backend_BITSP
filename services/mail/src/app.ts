import type { TokenVerifier } from '@onebox/auth-kit';
import { createServer, registerHealthRoutes, type HealthCheck } from '@onebox/http';
import type { Logger } from '@onebox/logger';
import type { AttachmentService } from './attachments/attachments';
import type { DriveService } from './drive/drive';
import type { LabelService } from './mail/label-service';
import type { MailService } from './mail/mail-service';
import type { MailboxService } from './mail/mailbox-service';
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
    drive?: DriveService;
    verifyToken: TokenVerifier;
  };
}

export function buildApp(deps: AppDeps) {
  const app = createServer({ logger: deps.logger });
  registerHealthRoutes(app, deps.checks);
  if (deps.routes) registerMailRoutes(app, deps.routes);
  return app;
}
