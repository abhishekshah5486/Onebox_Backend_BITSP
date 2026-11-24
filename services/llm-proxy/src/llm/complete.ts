import { createHash } from 'node:crypto';
import { ExternalServiceError, PaymentRequiredError } from '@onebox/errors';
import type { Logger } from '@onebox/logger';
import { Ajv, type ValidateFunction } from 'ajv';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Redis } from 'ioredis';
import {
  PROVIDERS,
  llmCalls,
  type AttemptRecord,
  type ModelRow,
  type Provider,
  type Purpose,
} from '../db/schema';
import {
  ProviderError,
  type ChatMessage,
  type ProviderAdapter,
  type ProviderResponse,
} from '../providers/types';
import type { Billing } from './billing';
import type { Breaker } from './breaker';
import { sdkAdapter } from '../byok/sdk-adapter';
import type { UserModels } from '../byok/user-models';
import { AUTO, OWN_PREFIX, type Catalog } from './catalog';

export interface CompleteInput {
  userId: string;
  purpose: Purpose;
  messages: ChatMessage[];
  // When given, the answer is JSON validated against it.
  schema?: { name: string; schema: Record<string, unknown> } | undefined;
  // Overrides the user's choice for this one call.
  model?: string | undefined;
  maxOutputTokens?: number | undefined;
  temperature?: number | undefined;
  cache?: boolean | undefined;
  // The caller's reference for the log, e.g. a message id. Never content.
  subject?: string | undefined;
  traceId?: string | undefined;
}

export interface CompleteResult {
  output: unknown;
  model: string;
  // OneBox's provider, or the catalogue id of a user's own (e.g. "groq").
  provider: string;
  usage: CallUsage;
  cached: boolean;
  attempts: AttemptRecord[];
}

export interface CallUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

type Prices = Pick<ModelRow, 'inputPrice' | 'outputPrice' | 'cacheReadPrice' | 'cacheWritePrice'>;

// A model the call may be answered by: one of OneBox's, or the user's own (free to OneBox).
interface Candidate {
  id: string;
  name: string;
  provider: string;
  hosted: Provider | null;
  adapter: ProviderAdapter;
  prices: Prices;
}

const FREE: Prices = { inputPrice: 0, outputPrice: 0, cacheReadPrice: 0, cacheWritePrice: 0 };

// What one reply cost in USD; prices are per million tokens and cached input is billed at its own rate.
export function costOf(prices: Prices, reply: Omit<ProviderResponse, 'text'>) {
  const fresh = Math.max(reply.inputTokens - reply.cacheReadTokens - reply.cacheWriteTokens, 0);
  return (
    (fresh * prices.inputPrice +
      reply.cacheReadTokens * prices.cacheReadPrice +
      reply.cacheWriteTokens * prices.cacheWritePrice +
      reply.outputTokens * prices.outputPrice) /
    1_000_000
  );
}

const RETRY_DELAY_MS = 800;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Models sometimes wrap JSON in a code fence; take what is inside.
export function parseJson(text: string): unknown {
  const fenced = text.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return JSON.parse(fenced ? fenced[1]! : text);
}

export function createCompleter({
  db,
  redis,
  catalog,
  breaker,
  adapters,
  logger,
  cacheTtlSeconds,
  timeoutMs,
  billing,
  userModels,
}: {
  db: PostgresJsDatabase;
  redis: Redis;
  catalog: Catalog;
  breaker: Breaker;
  adapters: Partial<Record<Provider, ProviderAdapter>>;
  logger: Logger;
  cacheTtlSeconds: number;
  timeoutMs: number;
  // Credits: checked before a model is asked, charged after. Absent, calls are free.
  billing?: Billing;
  // Models users added with their own keys, picked as "user:<id>".
  userModels?: Pick<UserModels, 'resolve'>;
}) {
  const ajv = new Ajv({ strict: false, allErrors: true });
  const validators = new Map<string, ValidateFunction>();
  const validatorFor = (schema: Record<string, unknown>) => {
    const key = JSON.stringify(schema);
    let validate = validators.get(key);
    if (!validate) {
      validate = ajv.compile(schema);
      validators.set(key, validate);
    }
    return validate;
  };

  // A schema-checked answer, or the reason it is not one.
  function check(text: string, schema: CompleteInput['schema']) {
    if (!schema) return { ok: true as const, output: text };
    let output: unknown;
    try {
      output = parseJson(text);
    } catch {
      return { ok: false as const, problem: 'The reply was not valid JSON.' };
    }
    const validate = validatorFor(schema.schema);
    if (validate(output)) return { ok: true as const, output };
    return { ok: false as const, problem: ajv.errorsText(validate.errors) };
  }

  async function tryModel(
    model: Candidate,
    input: CompleteInput,
    attempts: AttemptRecord[],
    usage: CallUsage,
  ) {
    const count = (reply: ProviderResponse) => {
      usage.inputTokens += reply.inputTokens;
      usage.outputTokens += reply.outputTokens;
      usage.cacheReadTokens += reply.cacheReadTokens;
      usage.cacheWriteTokens += reply.cacheWriteTokens;
      usage.costUsd += reply.costUsd ?? costOf(model.prices, reply);
    };
    const { adapter } = model;
    const request = {
      model: model.hosted ? model.id : '',
      messages: input.messages,
      schema: input.schema,
      maxOutputTokens: input.maxOutputTokens ?? 1024,
      temperature: input.temperature,
      timeoutMs,
    };

    for (let attempt = 1; attempt <= 2; attempt++) {
      const started = Date.now();
      try {
        const reply = await adapter.complete(request);
        count(reply);
        let checked = check(reply.text, input.schema);
        // One repair round: show the model its own answer and what was wrong with it.
        if (!checked.ok) {
          const repaired = await adapter.complete({
            ...request,
            messages: [
              ...input.messages,
              { role: 'assistant', content: reply.text },
              {
                role: 'user',
                content: `That reply did not match the required format (${checked.problem}). Reply again with only JSON that matches it.`,
              },
            ],
          });
          count(repaired);
          checked = check(repaired.text, input.schema);
        }
        if (!checked.ok) {
          attempts.push({
            model: model.id,
            outcome: 'invalid_output',
            error: checked.problem,
            latencyMs: Date.now() - started,
          });
          return null;
        }
        attempts.push({ model: model.id, outcome: 'ok', latencyMs: Date.now() - started });
        await breaker.success(model.id);
        return checked.output;
      } catch (err) {
        const error =
          err instanceof ProviderError
            ? err
            : new ProviderError((err as Error).message, 'UNKNOWN', true);
        attempts.push({
          model: model.id,
          outcome: 'error',
          error: `${error.code}: ${error.message.slice(0, 200)}`,
          latencyMs: Date.now() - started,
        });
        if (!error.retryable || attempt === 2) {
          // One failed request counts once toward the breaker, however many tries it took.
          if (await breaker.failure(model.id)) {
            logger.warn({ model: model.id }, 'model failing, skipping it for a minute');
          }
          return null;
        }
        await sleep(RETRY_DELAY_MS * attempt);
      }
    }
    return null;
  }

  async function ownModel(userId: string, requested: string): Promise<Candidate | null> {
    if (!requested.startsWith(OWN_PREFIX) || !userModels) return null;
    try {
      const { row, provider, sdk } = await userModels.resolve(
        userId,
        requested.slice(OWN_PREFIX.length),
      );
      if (row.kind !== 'llm') return null;
      return {
        id: requested,
        name: row.name,
        provider: provider.id,
        hosted: null,
        adapter: sdkAdapter(sdk.languageModel(row.modelId)),
        prices: FREE,
      };
    } catch (err) {
      // A removed model falls back to Auto rather than failing the feature.
      logger.warn({ userId, requested, err: (err as Error).message }, 'own model unusable');
      return null;
    }
  }

  return async function complete(input: CompleteInput): Promise<CompleteResult> {
    const started = Date.now();
    const requested = input.model ?? (await catalog.choiceOf(input.userId, input.purpose));
    const requestHash = createHash('sha256')
      .update(
        JSON.stringify([
          input.purpose,
          requested,
          input.messages,
          input.schema ?? null,
          input.temperature ?? null,
          input.maxOutputTokens ?? null,
        ]),
      )
      .digest('hex');
    const cacheKey = `llm:cache:${requestHash}`;
    const attempts: AttemptRecord[] = [];
    const usage: CallUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
    };

    const record = (row: Partial<typeof llmCalls.$inferInsert> & { status: string }) =>
      db
        .insert(llmCalls)
        .values({
          userId: input.userId,
          purpose: input.purpose,
          subject: input.subject ?? null,
          traceId: input.traceId ?? null,
          requestedModel: requested,
          ...usage,
          latencyMs: Date.now() - started,
          attempts,
          requestHash,
          ...row,
        })
        .returning({ id: llmCalls.id })
        .then(([row]) => row?.id ?? null)
        .catch((err: unknown) => {
          logger.error({ err }, 'could not record llm call');
          return null;
        });

    if (input.cache !== false && cacheTtlSeconds > 0) {
      const hit = await redis.get(cacheKey);
      if (hit) {
        const cached = JSON.parse(hit) as Omit<CompleteResult, 'cached' | 'attempts'>;
        await record({
          status: 'ok',
          cacheHit: true,
          modelUsed: cached.model,
          provider: PROVIDERS.find((provider) => provider === cached.provider) ?? null,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsd: 0,
        });
        return { ...cached, cached: true, attempts };
      }
    }

    // The user's own model first, with OneBox's Auto route behind it should it fail.
    const own = await ownModel(input.userId, requested);
    const hosted = (await catalog.chain(input.purpose, own ? AUTO : requested)).flatMap((model) => {
      const adapter = adapters[model.provider];
      return adapter
        ? [
            {
              id: model.id,
              name: model.name,
              provider: model.provider,
              hosted: model.provider,
              adapter,
              prices: model,
            },
          ]
        : [];
    });
    const chain: Candidate[] = own ? [own, ...hosted] : hosted;
    let creditsChecked = false;
    for (const model of chain) {
      // Credits matter only once OneBox's own models are asked.
      if (model.hosted && billing && !creditsChecked) {
        creditsChecked = true;
        if (!(await billing.allowed(input.userId))) {
          if (own) break;
          throw new PaymentRequiredError(
            "You're out of AI credits. Upgrade your plan or wait for your credits to reset.",
            { code: 'OUT_OF_CREDITS' },
          );
        }
      }
      if (await breaker.isOpen(model.id)) {
        attempts.push({
          model: model.id,
          outcome: 'skipped',
          error: 'recently failing',
          latencyMs: 0,
        });
        continue;
      }
      const output = await tryModel(model, input, attempts, usage);
      if (output === null) continue;

      const result = { output, model: model.id, provider: model.provider, usage };
      if (input.cache !== false && cacheTtlSeconds > 0) {
        await redis.set(cacheKey, JSON.stringify(result), 'EX', cacheTtlSeconds);
      }
      const callId = await record({ status: 'ok', modelUsed: model.id, provider: model.hosted });
      if (billing && callId && usage.costUsd > 0) {
        await billing
          .charge(input.userId, {
            callId,
            purpose: input.purpose,
            model: model.id,
            modelName: model.name,
            costUsd: usage.costUsd,
          })
          .catch((err: unknown) => logger.error({ err, callId }, 'could not report usage'));
      }
      if (attempts.length > 1) {
        logger.info(
          { purpose: input.purpose, requested, used: model.id, tries: attempts.length },
          'llm call fell back',
        );
      }
      return { ...result, cached: false, attempts };
    }

    const last = attempts.at(-1)?.error?.split(':')[0] ?? 'NO_MODEL';
    await record({ status: 'failed', errorCode: last });
    logger.error(
      { purpose: input.purpose, requested, attempts: attempts.length },
      'no model could answer',
    );
    // A model answered, but never in the required format: a caller may ask for less.
    const misshapen = attempts.some((attempt) => attempt.outcome === 'invalid_output');
    throw new ExternalServiceError(
      chain.length === 0
        ? 'No language model is available'
        : misshapen
          ? 'No language model answered in the required format'
          : 'No language model could answer right now',
      misshapen ? { code: 'INVALID_OUTPUT' } : {},
    );
  };
}

export type Completer = ReturnType<typeof createCompleter>;
