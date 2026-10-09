import { randomUUID } from 'node:crypto';
import { decrypt, encrypt } from '@onebox/crypto';
import { isUniqueViolation } from '@onebox/db-pg';
import { ConflictError, NotFoundError, ValidationError } from '@onebox/errors';
import type { Logger } from '@onebox/logger';
import { resolvePublicHost, safeFetch, SafeFetchError } from '@onebox/net-guard';
import { and, asc, count, eq, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { integrations, type IntegrationRow, type INTEGRATION_EVENTS } from '../db/schema';
import { generateWebhookSecret, SIGNATURE_HEADER, signWebhook } from './signing';

type IntegrationEvent = (typeof INTEGRATION_EVENTS)[number];

type IntegrationConfig = { webhookUrl: string } | { url: string; secret: string };

export type CreateIntegrationInput =
  | { type: 'SLACK'; name: string; webhookUrl: string; events: IntegrationEvent[] }
  | { type: 'WEBHOOK'; name: string; url: string; events: IntegrationEvent[] };

export interface UpdateIntegrationInput {
  name?: string | undefined;
  enabled?: boolean | undefined;
  events?: IntegrationEvent[] | undefined;
  target?: string | undefined;
}

export interface IntegrationServiceDeps {
  db: PostgresJsDatabase;
  encryptionKey: Buffer;
  logger: Logger;
  allowPrivateHosts?: boolean;
  send?: typeof safeFetch;
  maxPerUser?: number;
}

export function maskTarget(type: IntegrationRow['type'], target: string): string {
  const url = new URL(target);
  if (type === 'SLACK') {
    const [, , workspace = '', , token = ''] = url.pathname.split('/');
    return `${url.host}/services/${workspace}/…/…${token.slice(-4)}`;
  }
  return `${url.origin}${url.pathname}`;
}

export function toView(row: IntegrationRow) {
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    target: row.targetHint,
    events: row.events as IntegrationEvent[],
    enabled: row.enabled,
    lastTestedAt: row.lastTestedAt?.toISOString() ?? null,
    lastTestOk: row.lastTestOk,
    lastError: row.lastError,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export type IntegrationView = ReturnType<typeof toView>;

const aadFor = (id: string) => `integration:${id}`;

export const SLACK_WEBHOOK =
  /^https:\/\/hooks\.slack\.com\/services\/[A-Z0-9]+\/[A-Z0-9]+\/[A-Za-z0-9]+$/;

export function createIntegrationService({
  db,
  encryptionKey,
  logger,
  allowPrivateHosts = false,
  send = safeFetch,
  maxPerUser = 20,
}: IntegrationServiceDeps) {
  const readConfig = (row: IntegrationRow) =>
    JSON.parse(decrypt(row.configEncrypted, encryptionKey, aadFor(row.id))) as IntegrationConfig;
  const writeConfig = (id: string, config: IntegrationConfig) =>
    encrypt(JSON.stringify(config), encryptionKey, aadFor(id));

  async function assertDeliverable(type: IntegrationRow['type'], target: string) {
    if (type === 'SLACK' && !SLACK_WEBHOOK.test(target)) {
      throw new ValidationError(
        'Use a Slack incoming webhook URL (https://hooks.slack.com/services/…)',
        {
          code: 'INVALID_SLACK_WEBHOOK',
        },
      );
    }
    const url = new URL(target);
    if (url.protocol !== 'https:' && !(allowPrivateHosts && url.protocol === 'http:')) {
      throw new ValidationError('Webhook URLs must use https', { code: 'INSECURE_URL' });
    }
    await resolvePublicHost(url.hostname.replace(/^\[|\]$/g, ''), {
      allowPrivate: allowPrivateHosts,
    });
  }

  async function findOwned(userId: string, id: string) {
    const [row] = await db
      .select()
      .from(integrations)
      .where(and(eq(integrations.id, id), eq(integrations.userId, userId)));
    if (!row) throw new NotFoundError('Integration not found');
    return row;
  }

  async function save(id: string, changes: Partial<IntegrationRow>) {
    const [row] = await db
      .update(integrations)
      .set(changes)
      .where(eq(integrations.id, id))
      .returning();
    return row!;
  }

  const duplicateName = (err: unknown) =>
    isUniqueViolation(err)
      ? new ConflictError('An integration with this name already exists', {
          code: 'INTEGRATION_EXISTS',
        })
      : err;

  return {
    async list(userId: string): Promise<IntegrationView[]> {
      const rows = await db
        .select()
        .from(integrations)
        .where(eq(integrations.userId, userId))
        .orderBy(asc(integrations.createdAt));
      return rows.map(toView);
    },

    async get(userId: string, id: string): Promise<IntegrationView> {
      return toView(await findOwned(userId, id));
    },

    async create(userId: string, input: CreateIntegrationInput) {
      const limitReached = () =>
        new ConflictError(`You can add up to ${maxPerUser} integrations`, {
          code: 'INTEGRATION_LIMIT_REACHED',
        });
      const countFor = (tx: PostgresJsDatabase) =>
        tx
          .select({ total: count() })
          .from(integrations)
          .where(eq(integrations.userId, userId))
          .then(([row]) => row?.total ?? 0);
      // A quick check before the slow DNS lookup; the count that counts is taken under a lock.
      if ((await countFor(db)) >= maxPerUser) throw limitReached();

      const target = input.type === 'SLACK' ? input.webhookUrl : input.url;
      await assertDeliverable(input.type, target);
      const id = randomUUID();
      const secret = input.type === 'WEBHOOK' ? generateWebhookSecret() : undefined;
      const config: IntegrationConfig = secret ? { url: target, secret } : { webhookUrl: target };

      try {
        const row = await db.transaction(async (tx) => {
          // One create per user at a time, so concurrent requests cannot pass the limit.
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtext(${`integrations:${userId}`}))`,
          );
          if ((await countFor(tx)) >= maxPerUser) throw limitReached();
          const [inserted] = await tx
            .insert(integrations)
            .values({
              id,
              userId,
              type: input.type,
              name: input.name,
              configEncrypted: writeConfig(id, config),
              targetHint: maskTarget(input.type, target),
              events: input.events,
            })
            .returning();
          return inserted!;
        });
        logger.info({ userId, integrationId: id, type: input.type }, 'integration created');
        // The signing secret is returned exactly once; it is never readable afterwards.
        return { ...toView(row), ...(secret && { secret }) };
      } catch (err) {
        throw duplicateName(err);
      }
    },

    async update(
      userId: string,
      id: string,
      input: UpdateIntegrationInput,
    ): Promise<IntegrationView> {
      const row = await findOwned(userId, id);
      const changes: Partial<IntegrationRow> = {};
      if (input.name !== undefined) changes.name = input.name;
      if (input.enabled !== undefined) changes.enabled = input.enabled;
      if (input.events !== undefined) changes.events = input.events;
      if (input.target !== undefined) {
        await assertDeliverable(row.type, input.target);
        const current = readConfig(row);
        const config: IntegrationConfig =
          'secret' in current
            ? { url: input.target, secret: current.secret }
            : { webhookUrl: input.target };
        changes.configEncrypted = writeConfig(row.id, config);
        changes.targetHint = maskTarget(row.type, input.target);
        Object.assign(changes, { lastTestedAt: null, lastTestOk: null, lastError: null });
      }
      if (Object.keys(changes).length === 0) return toView(row);
      try {
        const updated = await save(row.id, changes);
        logger.info(
          { userId, integrationId: id, fields: Object.keys(changes) },
          'integration updated',
        );
        return toView(updated);
      } catch (err) {
        throw duplicateName(err);
      }
    },

    async rotateSecret(userId: string, id: string) {
      const row = await findOwned(userId, id);
      const current = readConfig(row);
      if (!('secret' in current)) {
        throw new ValidationError('Only webhook integrations have a signing secret', {
          code: 'NOT_SUPPORTED',
        });
      }
      const secret = generateWebhookSecret();
      const updated = await save(row.id, {
        configEncrypted: writeConfig(row.id, { ...current, secret }),
      });
      logger.info({ userId, integrationId: id }, 'webhook secret rotated');
      return { ...toView(updated), secret };
    },

    async test(userId: string, id: string) {
      const row = await findOwned(userId, id);
      const config = readConfig(row);
      const deliveryId = randomUUID();
      let request: { url: string; body: string; headers: Record<string, string> };

      if ('secret' in config) {
        const body = JSON.stringify({
          id: deliveryId,
          type: 'integration.test',
          createdAt: new Date().toISOString(),
          data: { integrationId: row.id, name: row.name },
        });
        request = {
          url: config.url,
          body,
          headers: {
            [SIGNATURE_HEADER]: signWebhook(config.secret, body),
            'x-onebox-event': 'integration.test',
            'x-onebox-delivery': deliveryId,
          },
        };
      } else {
        request = {
          url: config.webhookUrl,
          body: JSON.stringify({
            text: `:white_check_mark: OneBox is connected to *${row.name}*. Alerts will appear here.`,
          }),
          headers: {},
        };
      }

      let outcome: { ok: boolean; status?: number; error?: string };
      try {
        const response = await send(request.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'user-agent': 'OneBox-Webhooks/1.0',
            ...request.headers,
          },
          body: request.body,
          allowPrivate: allowPrivateHosts,
        });
        outcome = response.ok
          ? { ok: true, status: response.status }
          : {
              ok: false,
              status: response.status,
              error: `Endpoint responded with HTTP ${response.status}`,
            };
      } catch (err) {
        const message =
          err instanceof SafeFetchError ? `${err.code}: ${err.message}` : 'Delivery failed';
        outcome = { ok: false, error: message };
      }

      const updated = await save(row.id, {
        lastTestedAt: new Date(),
        lastTestOk: outcome.ok,
        lastError: outcome.ok ? null : (outcome.error ?? null),
      });
      logger[outcome.ok ? 'info' : 'warn'](
        { userId, integrationId: id, ok: outcome.ok, status: outcome.status },
        'integration test delivered',
      );
      return { ...outcome, integration: toView(updated) };
    },

    async remove(userId: string, id: string) {
      const deleted = await db
        .delete(integrations)
        .where(and(eq(integrations.id, id), eq(integrations.userId, userId)))
        .returning({ id: integrations.id });
      if (deleted.length === 0) throw new NotFoundError('Integration not found');
      logger.info({ userId, integrationId: id }, 'integration removed');
    },
  };
}

export type IntegrationService = ReturnType<typeof createIntegrationService>;
