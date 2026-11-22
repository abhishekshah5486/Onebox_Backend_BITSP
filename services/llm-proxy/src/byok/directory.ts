import type { Logger } from '@onebox/logger';
import { eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { z } from 'zod';
import { providerCatalog } from '../db/schema';
import { sdkFor } from './sdks';

// The models.dev shape, as far as OneBox reads it.
const modelSchema = z.object({
  id: z.string(),
  name: z.string(),
  reasoning: z.boolean().optional(),
  attachment: z.boolean().optional(),
  tool_call: z.boolean().optional(),
  status: z.string().optional(),
  modalities: z
    .object({ input: z.array(z.string()) })
    .partial()
    .optional(),
  limit: z.object({ context: z.number(), output: z.number() }).partial().optional(),
  cost: z.object({ input: z.number(), output: z.number() }).partial().optional(),
});
const providerSchema = z.object({
  id: z.string(),
  name: z.string(),
  npm: z.string().optional(),
  api: z.string().optional(),
  doc: z.string().optional(),
  env: z.array(z.string()).default([]),
  models: z.record(z.string(), z.unknown()),
});
const catalogSchema = z.record(z.string(), z.unknown());

export interface ProviderField {
  key: string;
  label: string;
  secret: boolean;
  required: boolean;
  multiline: boolean;
  default?: string;
}

export interface DirectoryModel {
  id: string;
  name: string;
  contextTokens: number | null;
  outputTokens: number | null;
  reasoning: boolean;
  multimodal: boolean;
  toolCalls: boolean;
  deprecated: boolean;
  embedding: boolean;
  usdPerMillion: { input: number; output: number } | null;
}

export interface DirectoryProvider {
  id: string;
  name: string;
  npm: string;
  logoUrl: string | null;
  docsUrl: string | null;
  fields: ProviderField[];
  models: DirectoryModel[];
}

const SECRET = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS/;
const camel = (words: string[]) =>
  words
    .map((w, i) => (i ? w[0]!.toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase()))
    .join('');

// AWS_SECRET_ACCESS_KEY -> the first of secretAccessKey, accessKey, key the SDK takes; a secret
// it doesn't name (e.g. AWS_BEARER_TOKEN_BEDROCK) is its API key.
export function settingFor(envName: string, accepted: string[]) {
  const words = envName.split('_');
  for (let start = 0; start < words.length; start += 1) {
    const key = camel(words.slice(start));
    if (accepted.includes(key)) return key;
  }
  return SECRET.test(envName) && accepted.includes('apiKey') ? 'apiKey' : null;
}

const LABELS: Record<string, string> = { apiKey: 'API key', baseURL: 'Base URL' };
const label = (key: string) =>
  LABELS[key] ??
  key
    .replace(/([A-Z])/g, ' $1')
    .toLowerCase()
    .replace(/^./, (c) => c.toUpperCase())
    .replace(/ id$/, ' ID');
const isSecret = (key: string) => /secret|token|password|credentials|key$/i.test(key);
// A server on the user's own machine or network may not need a key; a hosted one does.
const isLocal = (url: string | undefined) =>
  url !== undefined && /^https?:\/\/(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(url);

function fieldsOf(provider: z.infer<typeof providerSchema>) {
  const sdk = sdkFor(provider.npm)!;
  const named = new Set(
    provider.env.map((env) => settingFor(env, sdk.settings)).filter((key) => key !== null),
  );
  const listed = new Set(named);
  // The SDK's own required settings always show, e.g. a base URL models.dev gives as `api`.
  for (const key of sdk.required) named.add(key);
  return sdk.settings
    .filter((key) => named.has(key))
    .map((key) => ({
      key,
      label: key === 'credentials' ? 'Service account JSON' : label(key),
      secret: isSecret(key),
      required:
        sdk.required.includes(key) ||
        (key === 'apiKey' && listed.has('apiKey') && !isLocal(provider.api) && !sdk.optionalKey),
      multiline: key === 'credentials',
      ...(key === 'baseURL' && provider.api && { default: provider.api }),
    }));
}

function modelOf(raw: unknown): DirectoryModel | null {
  const parsed = modelSchema.safeParse(raw);
  if (!parsed.success) return null;
  const m = parsed.data;
  return {
    id: m.id,
    name: m.name,
    contextTokens: m.limit?.context ?? null,
    outputTokens: m.limit?.output ?? null,
    reasoning: m.reasoning ?? false,
    multimodal: (m.modalities?.input ?? []).includes('image') || (m.attachment ?? false),
    toolCalls: m.tool_call ?? false,
    deprecated: m.status === 'deprecated',
    embedding: /embed/i.test(m.id),
    usdPerMillion:
      m.cost?.input !== undefined ? { input: m.cost.input, output: m.cost.output ?? 0 } : null,
  };
}

// Providers OneBox can call (their AI SDK package is installed), from a models.dev catalogue.
export function parseCatalog(body: unknown, logoBase: string | null): DirectoryProvider[] {
  const providers: DirectoryProvider[] = [];
  for (const raw of Object.values(catalogSchema.parse(body))) {
    const parsed = providerSchema.safeParse(raw);
    if (!parsed.success || !sdkFor(parsed.data.npm)) continue;
    const provider = parsed.data;
    providers.push({
      id: provider.id,
      name: provider.name,
      npm: provider.npm!,
      logoUrl: logoBase ? `${logoBase}/${provider.id}.svg` : null,
      docsUrl: provider.doc ?? null,
      fields: fieldsOf(provider),
      models: Object.values(provider.models)
        .map(modelOf)
        .filter((model) => model !== null),
    });
  }
  return providers.sort((a, b) => a.name.localeCompare(b.name));
}

// Any OpenAI-compatible server the user runs or rents, which no catalogue can list.
export const CUSTOM_PROVIDER: DirectoryProvider = {
  id: 'openai-compatible',
  name: 'OpenAI compatible',
  npm: '@ai-sdk/openai-compatible',
  logoUrl: null,
  docsUrl: null,
  fields: [
    { key: 'baseURL', label: 'Base URL', secret: false, required: true, multiline: false },
    { key: 'apiKey', label: 'API key', secret: true, required: false, multiline: false },
  ],
  models: [],
};

const SOURCE = 'models.dev';
const RETRY_MS = 5 * 60_000;

// The catalogue, refreshed from models.dev now and then; the last good copy is kept in the
// database so a restart while models.dev is down still has every provider.
export function createProviderDirectory({
  db,
  url,
  ttlMs,
  logger,
  featured = [],
  fetchFn = fetch,
}: {
  db: PostgresJsDatabase;
  url: string;
  ttlMs: number;
  logger: Logger;
  // Provider ids to offer, in order; empty offers all.
  featured?: string[];
  fetchFn?: typeof fetch;
}) {
  const logoBase = new URL('/logos', url).toString();
  let cached: { at: number; providers: Promise<DirectoryProvider[]> } | null = null;

  async function fromSource() {
    const response = await fetchFn(url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body: unknown = await response.json();
    const providers = parseCatalog(body, logoBase);
    await db
      .insert(providerCatalog)
      .values({ source: SOURCE, body: providers, fetchedAt: new Date() })
      .onConflictDoUpdate({
        target: providerCatalog.source,
        set: { body: providers, fetchedAt: new Date() },
      });
    logger.info({ providers: providers.length }, 'provider catalogue refreshed');
    return providers;
  }

  async function load(): Promise<DirectoryProvider[]> {
    try {
      return await fromSource();
    } catch (err) {
      logger.warn(
        { err: (err as Error).message },
        'provider catalogue unreachable; using saved copy',
      );
      const [saved] = await db
        .select()
        .from(providerCatalog)
        .where(eq(providerCatalog.source, SOURCE));
      const providers = (saved?.body as DirectoryProvider[] | undefined) ?? [];
      // The saved copy serves until a retry, sooner than a whole TTL.
      cached = { at: Date.now() - ttlMs + RETRY_MS, providers: Promise.resolve(providers) };
      return providers;
    }
  }

  async function all() {
    if (!cached || Date.now() - cached.at > ttlMs) {
      cached = { at: Date.now(), providers: load() };
    }
    return [...(await cached.providers), CUSTOM_PROVIDER];
  }

  return {
    // Every provider: the featured ones first in their order, then the rest by name.
    async providers() {
      const everything = await all();
      const first = featured
        .map((id) => everything.find((provider) => provider.id === id))
        .filter((provider) => provider !== undefined);
      const rest = everything
        .filter((provider) => !featured.includes(provider.id))
        .sort((a, b) => a.name.localeCompare(b.name));
      return [...first, ...rest];
    },
    async provider(id: string) {
      return (await all()).find((provider) => provider.id === id) ?? null;
    },
  };
}

export type ProviderDirectory = ReturnType<typeof createProviderDirectory>;
