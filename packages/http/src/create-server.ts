import { randomUUID } from 'node:crypto';
import { isAppError, toErrorResponse } from '@onebox/errors';
import type { Logger } from '@onebox/logger';
import Fastify, { LogController, type FastifyError } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';

export interface CreateServerOptions {
  logger: Logger;
}

const QUIET_ROUTES = new Set(['/health/live', '/health/ready']);

export function createServer({ logger }: CreateServerOptions) {
  const app = Fastify({
    loggerInstance: logger,
    logController: new LogController({
      disableRequestLogging: true,
      requestIdLogLabel: 'requestId',
    }),
    requestIdHeader: 'x-request-id',
    genReqId: () => randomUUID(),
    trustProxy: true,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.addHook('onRequest', async (request, reply) => {
    void reply.header('x-request-id', request.id);
  });

  app.addHook('onResponse', async (request, reply) => {
    if (QUIET_ROUTES.has(request.routeOptions.url ?? '')) return;
    request.log.info(
      {
        method: request.method,
        url: request.url,
        statusCode: reply.statusCode,
        durationMs: Math.round(reply.elapsedTime),
      },
      'request completed',
    );
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error.validation) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Request validation failed',
          details: error.validation.map((issue) => ({
            path: issue.instancePath,
            message: issue.message,
          })),
        },
      });
    }

    // Fastify's own client errors (malformed JSON, payload too large) keep their status.
    if (!isAppError(error) && error.statusCode && error.statusCode < 500) {
      return reply
        .status(error.statusCode)
        .send({ error: { code: error.code ?? 'BAD_REQUEST', message: error.message } });
    }

    const { statusCode, body } = toErrorResponse(error);
    if (statusCode >= 500) request.log.error({ err: error }, 'request failed');
    return reply.status(statusCode).send(body);
  });

  app.setNotFoundHandler((request, reply) =>
    reply.status(404).send({
      error: { code: 'NOT_FOUND', message: `Route ${request.method} ${request.url} not found` },
    }),
  );

  return app;
}

export type HttpServer = ReturnType<typeof createServer>;
