import { randomUUID } from 'node:crypto';
import { decrypt, encrypt } from '@onebox/crypto';
import { NotFoundError, ValidationError } from '@onebox/errors';
import type { Logger } from '@onebox/logger';
import { and, asc, count, eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { userModels, type ModelKind, type UserModelRow } from '../db/schema';
import type { DirectoryProvider, ProviderDirectory } from './directory';
import { checkSettings, connect, discoverModels, probe } from './probe';
import type { Settings } from './sdks';

const MAX_PER_KIND = 20;

export interface UserModelInput {
  kind: ModelKind;
  providerId: string;
  modelId: string;
  name?: string | undefined;
  settings: Settings;
  contextTokens?: number | undefined;
  reasoning?: boolean | undefined;
  multimodal?: boolean | undefined;
}

export type UserModelChanges = Partial<Omit<UserModelInput, 'kind' | 'providerId'>>;

// Enough of the key to tell two apart, never enough to use.
function keyHint(settings: Settings) {
  const secret = settings.apiKey ?? settings.secretAccessKey;
  return secret && secret.length >= 12 ? secret.slice(-4) : null;
}

// Models users add with their own credentials. Every add or credential change makes a real
// call first, and credentials are stored encrypted, bound to their user and row.
export function createUserModels({
  db,
  encryptionKey,
  directory,
  allowPrivateUrls,
  timeoutMs,
  logger,
}: {
  db: PostgresJsDatabase;
  encryptionKey: Buffer;
  directory: Pick<ProviderDirectory, 'provider'>;
  allowPrivateUrls: boolean;
  timeoutMs: number;
  logger: Logger;
}) {
  const aad = (row: Pick<UserModelRow, 'userId' | 'id'>) => `${row.userId}:${row.id}`;
  const settingsOf = (row: UserModelRow) =>
    JSON.parse(decrypt(row.credentials, encryptionKey, aad(row))) as Settings;

  async function providerOf(id: string) {
    const provider = await directory.provider(id);
    if (!provider) throw new ValidationError(`Unknown provider ${id}`);
    return provider;
  }

  async function view(row: UserModelRow) {
    const provider = await directory.provider(row.providerId);
    return {
      id: row.id,
      kind: row.kind,
      providerId: row.providerId,
      providerName: provider?.name ?? row.providerId,
      logoUrl: provider?.logoUrl ?? null,
      modelId: row.modelId,
      name: row.name,
      keyHint: row.keyHint,
      contextTokens: row.contextTokens,
      reasoning: row.reasoning,
      multimodal: row.multimodal,
      dimensions: row.dimensions,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async function owned(userId: string, id: string) {
    const [row] = await db
      .select()
      .from(userModels)
      .where(and(eq(userModels.id, id), eq(userModels.userId, userId)));
    if (!row) throw new NotFoundError('No such model');
    return row;
  }

  const known = (provider: DirectoryProvider, modelId: string) =>
    provider.models.find((model) => model.id === modelId);

  return {
    async list(userId: string, kind?: ModelKind) {
      const rows = await db
        .select()
        .from(userModels)
        .where(
          kind
            ? and(eq(userModels.userId, userId), eq(userModels.kind, kind))
            : eq(userModels.userId, userId),
        )
        .orderBy(asc(userModels.createdAt));
      return Promise.all(rows.map(view));
    },

    async discover(providerId: string, settings: Settings) {
      const provider = await providerOf(providerId);
      const clean = await checkSettings(provider, settings, allowPrivateUrls);
      return discoverModels(provider, clean, timeoutMs);
    },

    async add(userId: string, input: UserModelInput) {
      const provider = await providerOf(input.providerId);
      const [{ total } = { total: 0 }] = await db
        .select({ total: count() })
        .from(userModels)
        .where(and(eq(userModels.userId, userId), eq(userModels.kind, input.kind)));
      if (total >= MAX_PER_KIND) {
        throw new ValidationError(`You can add up to ${MAX_PER_KIND} models of each kind`);
      }
      const settings = await checkSettings(provider, input.settings, allowPrivateUrls);
      const { dimensions } = await probe(provider, input.kind, input.modelId, settings, timeoutMs);
      const listed = known(provider, input.modelId);
      const id = randomUUID();
      const [row] = await db
        .insert(userModels)
        .values({
          id,
          userId,
          kind: input.kind,
          providerId: provider.id,
          modelId: input.modelId,
          name: input.name?.trim() || listed?.name || input.modelId,
          credentials: encrypt(JSON.stringify(settings), encryptionKey, `${userId}:${id}`),
          keyHint: keyHint(settings),
          contextTokens: input.contextTokens ?? listed?.contextTokens ?? null,
          reasoning: input.reasoning ?? listed?.reasoning ?? false,
          multimodal: input.multimodal ?? listed?.multimodal ?? false,
          dimensions,
        })
        .returning();
      logger.info(
        { userId, kind: input.kind, provider: provider.id, model: input.modelId },
        'user model added',
      );
      return view(row!);
    },

    // Blank secrets keep the saved ones, so the form never has to show them.
    async update(userId: string, id: string, changes: UserModelChanges) {
      const row = await owned(userId, id);
      const provider = await providerOf(row.providerId);
      const saved = settingsOf(row);
      const filled = Object.fromEntries(
        Object.entries(changes.settings ?? {}).filter(([, value]) => value.trim() !== ''),
      );
      const settings = await checkSettings(provider, { ...saved, ...filled }, allowPrivateUrls);
      const modelId = changes.modelId ?? row.modelId;
      const retest = modelId !== row.modelId || JSON.stringify(settings) !== JSON.stringify(saved);
      const dimensions = retest
        ? (await probe(provider, row.kind, modelId, settings, timeoutMs)).dimensions
        : row.dimensions;
      const [updated] = await db
        .update(userModels)
        .set({
          modelId,
          name: changes.name?.trim() || row.name,
          credentials: encrypt(JSON.stringify(settings), encryptionKey, aad(row)),
          keyHint: keyHint(settings),
          contextTokens: changes.contextTokens ?? row.contextTokens,
          reasoning: changes.reasoning ?? row.reasoning,
          multimodal: changes.multimodal ?? row.multimodal,
          dimensions,
        })
        .where(eq(userModels.id, row.id))
        .returning();
      logger.info({ userId, id, retested: retest }, 'user model updated');
      return view(updated!);
    },

    async remove(userId: string, id: string) {
      const row = await owned(userId, id);
      await db.delete(userModels).where(eq(userModels.id, row.id));
      logger.info({ userId, id }, 'user model removed');
    },

    // A ready-to-call model, for the AI features and semantic search.
    async resolve(userId: string, id: string) {
      const row = await owned(userId, id);
      const provider = await providerOf(row.providerId);
      return { row, provider, sdk: connect(provider, settingsOf(row)) };
    },
  };
}

export type UserModels = ReturnType<typeof createUserModels>;
