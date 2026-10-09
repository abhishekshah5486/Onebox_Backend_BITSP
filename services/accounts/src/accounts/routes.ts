import { currentUser, requireUser, type TokenVerifier } from '@onebox/auth-kit';
import type { HttpServer } from '@onebox/http';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ACCOUNT_STATUSES, PROVIDERS } from '../db/schema';
import { PRESET_PROVIDERS } from '../imap/presets';
import type { AccountService } from './account-service';

const hostname = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(253)
  .regex(/^[a-z0-9.-]+$|^\[?[0-9a-f:.]+\]?$/, 'must be a hostname or ip address');

const server = z.object({
  host: hostname,
  port: z.number().int().min(1).max(65535),
  tls: z.boolean(),
});

const emailAddress = z.string().trim().toLowerCase().pipe(z.email().max(254));
const displayName = z.string().trim().min(1).max(100);
const password = z.string().min(1).max(1024);

const createBody = z.discriminatedUnion('provider', [
  z.object({
    provider: z.enum(PRESET_PROVIDERS),
    emailAddress,
    displayName: displayName.optional(),
    password,
  }),
  z.object({
    provider: z.literal('IMAP'),
    emailAddress,
    displayName: displayName.optional(),
    username: z.string().trim().min(1).max(254).optional(),
    password,
    imap: server,
    smtp: server.optional(),
  }),
]);

const updateBody = z
  .object({
    displayName: displayName.nullable().optional(),
    password: password.optional(),
    enabled: z.boolean().optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: 'Provide at least one field to update',
  });

// Response schemas make it impossible to serialise anything not listed, e.g. credentials.
const accountView = z.object({
  id: z.uuid(),
  provider: z.enum(PROVIDERS),
  emailAddress: z.string(),
  displayName: z.string().nullable(),
  username: z.string(),
  imap: server,
  smtp: server.nullable(),
  status: z.enum(ACCOUNT_STATUSES),
  lastError: z.string().nullable(),
  lastVerifiedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const params = z.object({ id: z.uuid() });

export function registerAccountRoutes(
  app: HttpServer,
  { accounts, verifyToken }: { accounts: AccountService; verifyToken: TokenVerifier },
) {
  app.decorateRequest('user', null);

  void app.register(
    async (scope) => {
      const routes = scope.withTypeProvider<ZodTypeProvider>();
      routes.addHook('preHandler', requireUser(verifyToken));

      routes.get(
        '/',
        { schema: { response: { 200: z.object({ items: z.array(accountView) }) } } },
        async (request) => ({ items: await accounts.list(currentUser(request).userId) }),
      );

      routes.post(
        '/',
        { schema: { body: createBody, response: { 201: accountView } } },
        async (request, reply) =>
          reply.status(201).send(await accounts.create(currentUser(request).userId, request.body)),
      );

      routes.get('/:id', { schema: { params, response: { 200: accountView } } }, async (request) =>
        accounts.get(currentUser(request).userId, request.params.id),
      );

      routes.patch(
        '/:id',
        { schema: { params, body: updateBody, response: { 200: accountView } } },
        async (request) =>
          accounts.update(currentUser(request).userId, request.params.id, request.body),
      );

      routes.post(
        '/:id/test',
        {
          schema: {
            params,
            response: {
              200: z.object({
                ok: z.boolean(),
                reason: z.string().optional(),
                message: z.string().optional(),
                account: accountView,
              }),
            },
          },
        },
        async (request) => {
          const { result, account } = await accounts.test(
            currentUser(request).userId,
            request.params.id,
          );
          return result.ok ? { ok: true, account } : { ...result, account };
        },
      );

      routes.delete('/:id', { schema: { params } }, async (request, reply) => {
        await accounts.remove(currentUser(request).userId, request.params.id);
        return reply.status(204).send();
      });
    },
    { prefix: '/accounts' },
  );
}
