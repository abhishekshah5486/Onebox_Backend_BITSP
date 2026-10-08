import { currentUser, requireUser, type TokenVerifier } from '@onebox/auth-kit';
import {
  folderRoleSchema,
  gmailCategorySchema,
  mailboxRoleSchema,
  mailboxTargetSchema,
  mailCategorySchema,
} from '@onebox/contracts';
import type { HttpServer } from '@onebox/http';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { MailService } from './mail-service';
import type { LabelService } from './label-service';
import type { MailboxService } from './mailbox-service';
import { THREAD_ACTIONS, type MailboxView, type ThreadActions } from './thread-actions';

const address = z.object({ name: z.string(), address: z.string() });

const threadView = z.object({
  id: z.string(),
  accountId: z.string(),
  folders: z.array(folderRoleSchema),
  labels: z.array(z.string()),
  category: gmailCategorySchema.nullable(),
  categories: z.array(mailCategorySchema),
  canUnsubscribe: z.boolean(),
  unsubscribedAt: z.string().nullable(),
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
  authentication: z
    .object({
      mailedBy: z.string().nullable(),
      signedBy: z.string().nullable(),
      encrypted: z.boolean().nullable(),
    })
    .nullable(),
});

const params = z.object({ id: z.string().regex(/^[0-9a-f]{64}$/, 'invalid conversation id') });
const accountParams = z.object({ accountId: z.uuid() });

const pageQuery = {
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
};

const labelPath = z.string().min(1).max(500);

const filterQuery = {
  filter: z.enum(['all', 'unread', 'starred']).default('all'),
  folder: folderRoleSchema.optional(),
  label: labelPath.optional(),
  category: gmailCategorySchema.optional(),
  tagged: mailCategorySchema.optional(),
};
const folderQuery = z.object({
  folder: folderRoleSchema.default('inbox'),
  label: labelPath.optional(),
});
const viewOf = (query: z.infer<typeof folderQuery>): MailboxView =>
  query.label ? { label: query.label } : { role: query.folder };

const mailboxView = z.union([z.object({ role: folderRoleSchema }), z.object({ label: labelPath })]);

const threadPage = z.object({
  items: z.array(threadView),
  page: z.number(),
  pageSize: z.number(),
  total: z.number(),
});

const mailboxSummary = z.object({
  accountId: z.string(),
  folder: mailboxRoleSchema,
  label: z.string().nullable(),
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
    actions,
    labels,
    verifyToken,
  }: {
    mail: MailService;
    mailboxes: MailboxService;
    actions: ThreadActions;
    labels: LabelService;
    verifyToken: TokenVerifier;
  },
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
              ...filterQuery,
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
        async (request) => {
          const { isRead, isStarred } = request.body;
          const threadIds = [request.params.id];
          if (isRead !== undefined) {
            await actions.apply(userId(request), { threadIds, action: isRead ? 'read' : 'unread' });
          }
          if (isStarred !== undefined) {
            await actions.apply(userId(request), {
              threadIds,
              action: isStarred ? 'star' : 'unstar',
            });
          }
          const [view] = await mail.threadViews(userId(request), threadIds);
          return view!;
        },
      );

      routes.post(
        '/threads/actions',
        {
          schema: {
            body: z
              .object({
                threadIds: z.array(params.shape.id).min(1).max(500),
                action: z.enum(THREAD_ACTIONS),
                from: mailboxView.optional(),
                to: mailboxTargetSchema.optional(),
              })
              .refine((body) => body.action !== 'move' || body.to, {
                message: 'Choose where to move the conversations',
              }),
            response: {
              200: z.object({ items: z.array(threadView), undoToken: z.string().nullable() }),
            },
          },
        },
        async (request) => {
          const { undoToken } = await actions.apply(userId(request), request.body);
          return {
            items: await mail.threadViews(userId(request), request.body.threadIds),
            undoToken,
          };
        },
      );

      routes.post(
        '/threads/undo',
        {
          schema: {
            body: z.object({ undoToken: z.string().min(1).max(20_000) }),
            response: { 200: z.object({ items: z.array(threadView) }) },
          },
        },
        async (request) => {
          const ids = await actions.undo(userId(request), request.body.undoToken);
          return { items: await mail.threadViews(userId(request), ids) };
        },
      );

      routes.post(
        '/threads/:id/unsubscribe',
        {
          schema: {
            params,
            response: {
              200: z.object({
                method: z.enum(['one-click', 'link', 'mailto']),
                url: z.string().nullable(),
              }),
            },
          },
        },
        async (request) => actions.unsubscribe(userId(request), request.params.id),
      );

      routes.get(
        '/accounts/:accountId/threads',
        {
          schema: {
            params: accountParams,
            querystring: z.object({ ...filterQuery, ...pageQuery }),
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
        {
          schema: {
            params: accountParams,
            querystring: folderQuery,
            response: { 200: mailboxSummary },
          },
        },
        async (request) =>
          mailboxes.summary(userId(request), request.params.accountId, viewOf(request.query)),
      );

      routes.get(
        '/accounts/:accountId/folders',
        {
          schema: {
            params: accountParams,
            response: {
              200: z.object({
                items: z.array(
                  z.object({
                    role: mailboxRoleSchema,
                    path: z.string(),
                    name: z.string(),
                    total: z.number(),
                    unread: z.number(),
                    updatedAt: z.string(),
                  }),
                ),
              }),
            },
          },
        },
        async (request) => mailboxes.folders(userId(request), request.params.accountId),
      );

      routes.post(
        '/accounts/:accountId/history',
        {
          schema: {
            params: accountParams,
            querystring: folderQuery,
            response: { 202: mailboxSummary },
          },
        },
        async (request, reply) =>
          reply
            .status(202)
            .send(
              await mailboxes.requestHistory(
                userId(request),
                request.params.accountId,
                viewOf(request.query),
              ),
            ),
      );

      const labelList = {
        200: z.object({ items: z.array(z.object({ path: z.string(), name: z.string() })) }),
      };
      const labelName = z.string().min(1).max(200);

      routes.post(
        '/accounts/:accountId/labels',
        {
          schema: {
            params: accountParams,
            body: z.object({ name: labelName }),
            response: { 201: labelList[200] },
          },
        },
        async (request, reply) =>
          reply
            .status(201)
            .send(
              await labels.create(userId(request), request.params.accountId, request.body.name),
            ),
      );

      routes.patch(
        '/accounts/:accountId/labels',
        {
          schema: {
            params: accountParams,
            body: z.object({ path: labelPath, name: labelName }),
            response: labelList,
          },
        },
        async (request) =>
          labels.rename(
            userId(request),
            request.params.accountId,
            request.body.path,
            request.body.name,
          ),
      );

      routes.post(
        '/accounts/:accountId/labels/delete',
        {
          schema: {
            params: accountParams,
            body: z.object({ path: labelPath }),
            response: labelList,
          },
        },
        async (request) =>
          labels.remove(userId(request), request.params.accountId, request.body.path),
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
