import { requireInternal } from '@onebox/auth-kit';
import { RAG_SKIPPED_ROLES } from '@onebox/contracts';
import { NotFoundError } from '@onebox/errors';
import type { HttpServer } from '@onebox/http';
import type { Collection } from 'mongodb';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { AttachmentService } from '../attachments/attachments';
import type { MessageDoc } from '../db/collections';

const query = z.object({ userId: z.string().min(1) });
const messageId = z.string().min(1).max(128);
const skipped = new Set<string>(RAG_SKIPPED_ROLES);

// Never routed by the gateway: the RAG service reads stored mail here, for a named user.
export function registerInternalMailRoutes(
  app: HttpServer,
  {
    messages,
    attachments,
    internalToken,
  }: {
    messages: Collection<MessageDoc>;
    attachments: AttachmentService;
    internalToken: string;
  },
) {
  void app.register(
    async (scope) => {
      const routes = scope.withTypeProvider<ZodTypeProvider>();
      routes.addHook('preHandler', requireInternal(internalToken));

      routes.get(
        '/messages/:id',
        { schema: { params: z.object({ id: messageId }), querystring: query } },
        async (request) => {
          const doc = await messages.findOne({
            _id: request.params.id,
            userId: request.query.userId,
          });
          if (!doc) throw new NotFoundError('Message not found');
          return {
            id: doc._id,
            accountId: doc.accountId,
            threadId: doc.threadId,
            messageIdHeader: doc.messageIdHeader,
            subject: doc.subject,
            from: doc.from,
            to: doc.to,
            cc: doc.cc,
            receivedAt: doc.receivedAt.toISOString(),
            sentAt: doc.sentAt?.toISOString() ?? null,
            textBody: doc.textBody,
            htmlBody: doc.htmlBody,
            attachments: doc.attachments.map((a, index) => ({
              index,
              filename: a.filename,
              contentType: a.contentType,
              sizeBytes: a.sizeBytes,
              inline: a.inline,
              sha256: a.sha256 ?? null,
            })),
          };
        },
      );

      // Every copy of an email the mailbox holds now (spam and trash too), and those RAG reads.
      routes.get(
        '/accounts/:accountId/copies',
        {
          schema: {
            params: z.object({ accountId: z.string().min(1).max(128) }),
            querystring: query.extend({ messageIdHeader: z.string().min(1).max(998) }),
          },
        },
        async (request) => {
          const copies = await messages
            .find(
              {
                userId: request.query.userId,
                accountId: request.params.accountId,
                messageIdHeader: request.query.messageIdHeader,
              },
              { projection: { _id: 1, role: 1 } },
            )
            .sort({ _id: 1 })
            .limit(100)
            .toArray();
          return {
            held: copies.map((copy) => copy._id),
            readable: copies.filter((copy) => !skipped.has(copy.role)).map((copy) => copy._id),
          };
        },
      );

      // Fetched from the mail server first when the contents were never stored.
      routes.get(
        '/messages/:id/attachments/:index',
        {
          schema: {
            params: z.object({ id: messageId, index: z.coerce.number().int().min(0).max(500) }),
            querystring: query,
          },
        },
        async (request, reply) => {
          const { meta, blob } = await attachments.open(
            request.query.userId,
            request.params.id,
            request.params.index,
          );
          void reply.header('content-type', 'application/octet-stream');
          if (blob.sizeBytes !== undefined) void reply.header('content-length', blob.sizeBytes);
          void reply.header('x-content-type', meta.contentType);
          return reply.send(blob.body);
        },
      );
    },
    { prefix: '/internal' },
  );
}
