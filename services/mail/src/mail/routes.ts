import { currentUser, requireUser, type TokenVerifier } from '@onebox/auth-kit';
import type { HttpServer } from '@onebox/http';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { MailService } from './mail-service';
import type { MailboxService } from './mailbox-service';

const address = z.object({ name: z.string(), address: z.string() });

const threadView = z.object({
  id: z.string(),
  accountId: z.string(),
  subject: z.string(),
  snippet: z.string(),
  participants: z.array(address),
  lastFrom: address.nullable(),
  messageCount: z.number(),
  unreadCount: z.number(),
  isStarred: z.boolean(),
  hasAttachments: z.boolean(),
  lastMessageAt: z.string(),
});

const messageView = z.object({
  id: z.string(),
  accountId: z.string(),
  from: address.nullable(),
  to: z.array(address),
  cc: z.array(address),
  replyTo: z.array(address),
  subject: z.string(),
  snippet: z.string(),
  textBody: z.string(),
  htmlBody: z.string().nullable(),
  hasRemoteImages: z.boolean(),
  attachments: z.array(
    z.object({
      filename: z.string(),
      contentType: z.string(),
      sizeBytes: z.number(),
      inline: z.boolean(),
    }),
  ),
  isRead: z.boolean(),
  isStarred: z.boolean(),
  receivedAt: z.string(),
  sentAt: z.string().nullable(),
});

const params = z.object({ id: z.string().regex(/^[0-9a-f]{64}$/, 'invalid conversation id') });
const accountParams = z.object({ accountId: z.uuid() });

const pageQuery = {
  cursor: z.string().max(200).optional(),
  direction: z.enum(['next', 'prev']).default('next'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
};

const threadPage = z.object({
  items: z.array(threadView),
  nextCursor: z.string().nullable(),
  prevCursor: z.string().nullable(),
});

const mailboxSummary = z.object({
  accountId: z.string(),
  server: z.object({ total: z.number(), unread: z.number(), updatedAt: z.string() }).nullable(),
  fetched: z.object({ conversations: z.number(), messages: z.number() }),
  history: z.object({
    status: z.enum(['idle', 'fetching', 'complete', 'error']),
    error: z.string().nullable(),
  }),
  hasMoreOnServer: z.boolean(),
});

export function registerMailRoutes(
  app: HttpServer,
  {
    mail,
    mailboxes,
    verifyToken,
  }: { mail: MailService; mailboxes: MailboxService; verifyToken: TokenVerifier },
) {
  app.decorateRequest('user', null);

  void app.register(
    async (scope) => {
      const routes = scope.withTypeProvider<ZodTypeProvider>();
      routes.addHook('preHandler', requireUser(verifyToken));
      const userId = (request: Parameters<typeof currentUser>[0]) => currentUser(request).userId;

      routes.get(
        '/threads',
        {
          schema: {
            querystring: z.object({
              accountId: z.uuid().optional(),
              filter: z.enum(['all', 'unread', 'starred']).default('all'),
              ...pageQuery,
            }),
            response: { 200: threadPage },
          },
        },
        async (request) => mail.listThreads(userId(request), request.query),
      );

      routes.get(
        '/threads/:id',
        {
          schema: {
            params,
            response: { 200: z.object({ thread: threadView, messages: z.array(messageView) }) },
          },
        },
        async (request) => mail.getThread(userId(request), request.params.id),
      );

      routes.patch(
        '/threads/:id',
        {
          schema: {
            params,
            body: z
              .object({ isRead: z.boolean().optional(), isStarred: z.boolean().optional() })
              .refine((body) => body.isRead !== undefined || body.isStarred !== undefined, {
                message: 'Provide isRead or isStarred',
              }),
            response: { 200: threadView },
          },
        },
        async (request) => mail.updateThread(userId(request), request.params.id, request.body),
      );

      routes.get(
        '/accounts/:accountId/threads',
        {
          schema: {
            params: accountParams,
            querystring: z.object({
              filter: z.enum(['all', 'unread', 'starred']).default('all'),
              ...pageQuery,
            }),
            response: { 200: threadPage },
          },
        },
        async (request) =>
          mail.listThreads(userId(request), {
            ...request.query,
            accountId: request.params.accountId,
          }),
      );

      routes.get(
        '/accounts/:accountId/summary',
        { schema: { params: accountParams, response: { 200: mailboxSummary } } },
        async (request) => mailboxes.summary(userId(request), request.params.accountId),
      );

      routes.post(
        '/accounts/:accountId/history',
        { schema: { params: accountParams, response: { 202: mailboxSummary } } },
        async (request, reply) =>
          reply
            .status(202)
            .send(await mailboxes.requestHistory(userId(request), request.params.accountId)),
      );

      routes.get(
        '/stats',
        {
          schema: {
            response: {
              200: z.object({
                unreadThreads: z.number(),
                starredThreads: z.number(),
                totalThreads: z.number(),
              }),
            },
          },
        },
        async (request) => mail.stats(userId(request)),
      );
    },
    { prefix: '/mail' },
  );
}
