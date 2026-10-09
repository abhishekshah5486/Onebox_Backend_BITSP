import { currentUser, requireUser, type TokenVerifier } from '@onebox/auth-kit';
import { MAX_SEND_BYTES, outgoingAttachmentSchema, recipientSchema } from '@onebox/contracts';
import { ValidationError } from '@onebox/errors';
import type { HttpServer } from '@onebox/http';
import type { FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { ComposeService } from './compose-service';

const composition = z.object({
  accountId: z.uuid().nullable(),
  to: z.array(recipientSchema).max(100).default([]),
  cc: z.array(recipientSchema).max(100).default([]),
  bcc: z.array(recipientSchema).max(100).default([]),
  subject: z.string().max(998).default(''),
  html: z.string().max(5_000_000).default(''),
  text: z.string().max(2_000_000).default(''),
  attachments: z.array(outgoingAttachmentSchema).max(50).default([]),
  replyTo: z
    .object({
      messageId: z.string().min(1).max(200),
      mode: z.enum(['reply', 'replyAll', 'forward']),
    })
    .nullable()
    .default(null),
});

// Drafts are saved under an id the editor picks; failed sends come back as failed-<id>.
const draftId = z.string().regex(/^(failed-)?[0-9a-f-]{36}$/);

export function registerComposeRoutes(
  app: HttpServer,
  deps: { compose: ComposeService; verifyToken: TokenVerifier },
) {
  const { compose } = deps;
  const userId = (request: FastifyRequest) => currentUser(request).userId;

  void app.register(
    async (scope) => {
      scope.addHook('preHandler', requireUser(deps.verifyToken));
      const routes = scope.withTypeProvider<ZodTypeProvider>();

      routes.get('/drafts', async (request) => ({
        items: await compose.listDrafts(userId(request)),
      }));
      routes.get(
        '/drafts/:id',
        { schema: { params: z.object({ id: draftId }) } },
        async (request) => compose.getDraft(userId(request), request.params.id),
      );
      routes.put(
        '/drafts/:id',
        { schema: { params: z.object({ id: draftId }), body: composition } },
        async (request) => compose.putDraft(userId(request), request.params.id, request.body),
      );
      routes.delete(
        '/drafts/:id',
        { schema: { params: z.object({ id: draftId }) } },
        async (request, reply) => {
          await compose.deleteDraft(userId(request), request.params.id);
          return reply.status(204).send();
        },
      );

      routes.post(
        '/send',
        {
          schema: {
            body: composition.extend({
              draftId: draftId.optional(),
              undoSeconds: z.number().int().min(0).max(30).optional(),
            }),
          },
        },
        async (request) => compose.send(userId(request), request.body),
      );
      routes.get('/outbox', async (request) => ({
        items: await compose.listOutbox(userId(request)),
      }));
      routes.post(
        '/outbox/:id/cancel',
        { schema: { params: z.object({ id: z.uuid() }) } },
        async (request) => compose.cancel(userId(request), request.params.id),
      );

      routes.get(
        '/contacts',
        { schema: { querystring: z.object({ q: z.string().max(200).default('') }) } },
        async (request) => ({ items: await compose.contacts(userId(request), request.query.q) }),
      );

      routes.post(
        '/uploads/from-message',
        {
          schema: {
            body: z.object({
              messageId: z.string().min(1).max(200),
              index: z.number().int().min(0),
            }),
          },
        },
        async (request) =>
          compose.attachFromMessage(userId(request), request.body.messageId, request.body.index),
      );

      // The file itself is the body, sent as octet-stream; its name (URI-encoded) and real type
      // come in X-Filename and X-Content-Type.
      void scope.register(async (uploads) => {
        uploads.addContentTypeParser(
          '*',
          { parseAs: 'buffer', bodyLimit: MAX_SEND_BYTES },
          (_request, body, done) => done(null, body),
        );
        uploads.post('/uploads', { bodyLimit: MAX_SEND_BYTES }, async (request) => {
          const header = request.headers['x-filename'];
          const raw = Array.isArray(header) ? header[0] : header;
          let filename: string;
          try {
            filename = decodeURIComponent(raw ?? '').trim();
          } catch {
            filename = '';
          }
          if (!filename || filename.length > 255)
            throw new ValidationError('Name the file in X-Filename');
          if (!Buffer.isBuffer(request.body))
            throw new ValidationError('Send the file as the body');
          const type = request.headers['x-content-type'];
          const contentType = (Array.isArray(type) ? type[0] : type)?.trim();
          return compose.upload(userId(request), {
            filename,
            contentType:
              contentType && /^[\w.+-]+\/[\w.+-]+$/.test(contentType)
                ? contentType
                : 'application/octet-stream',
            body: request.body,
          });
        });
      });
    },
    { prefix: '/mail' },
  );
}
