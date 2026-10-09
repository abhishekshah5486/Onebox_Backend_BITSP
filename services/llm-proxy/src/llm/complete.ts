import { createHash } from 'node:crypto';
import { ExternalServiceError, PaymentRequiredError } from '@onebox/errors';
import type { Logger } from '@onebox/logger';
import { Ajv, type ValidateFunction } from 'ajv';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Redis } from 'ioredis';
import {
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
import type { Catalog } from './catalog';

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
  provider: Provider;
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
    model: ModelRow,
    input: CompleteInput,
    attempts: AttemptRecord[],
    usage: CallUsage,
  ) {
    const count = (reply: ProviderResponse) => {
      usage.inputTokens += reply.inputTokens;
      usage.outputTokens += reply.outputTokens;
      usage.cacheReadTokens += reply.cacheReadTokens;
      usage.cacheWriteTokens += reply.cacheWriteTokens;
      usage.costUsd += reply.costUsd ?? costOf(model, reply);
    };
    const adapter = adapters[model.provider]!;
    const request = {
      model: model.id,
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
          provider: cached.provider,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsd: 0,
        });
        return { ...cached, cached: true, attempts };
      }
    }

    if (billing && !(await billing.allowed(input.userId))) {
      throw new PaymentRequiredError(
        "You're out of AI credits. Upgrade your plan or wait for your credits to reset.",
        { code: 'OUT_OF_CREDITS' },
      );
    }

    const chain = await catalog.chain(input.purpose, requested);
    for (const model of chain) {
      if (!adapters[model.provider]) continue;
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
      const callId = await record({ status: 'ok', modelUsed: model.id, provider: model.provider });
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
    throw new ExternalServiceError(
      chain.length === 0
        ? 'No language model is available'
        : 'No language model could answer right now',
    );
  };
}

export type Completer = ReturnType<typeof createCompleter>;
