import { and, desc, eq, gte, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { llmCalls } from '../db/schema';

// The most calls one page of the usage screen lists; totals always cover the whole period.
export const USAGE_CALL_LIMIT = 2000;

// What a user's AI use came to over a period: totals, and the calls themselves for the
// usage table to search, sort and group.
export function createUsage(db: PostgresJsDatabase) {
  const totals = {
    calls: sql<number>`count(*)::int`,
    inputTokens: sql<number>`coalesce(sum(${llmCalls.inputTokens}), 0)::int`,
    outputTokens: sql<number>`coalesce(sum(${llmCalls.outputTokens}), 0)::int`,
    cacheReadTokens: sql<number>`coalesce(sum(${llmCalls.cacheReadTokens}), 0)::int`,
    cacheWriteTokens: sql<number>`coalesce(sum(${llmCalls.cacheWriteTokens}), 0)::int`,
    costUsd: sql<number>`coalesce(sum(${llmCalls.costUsd}), 0)::float8`,
    cacheHits: sql<number>`count(*) filter (where ${llmCalls.cacheHit})::int`,
    failures: sql<number>`count(*) filter (where ${llmCalls.status} = 'failed')::int`,
  };

  return async function summary(userId: string, days: number) {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const scope = and(eq(llmCalls.userId, userId), gte(llmCalls.createdAt, since));

    const [overall, calls] = await Promise.all([
      db.select(totals).from(llmCalls).where(scope),
      db
        .select({
          id: llmCalls.id,
          purpose: llmCalls.purpose,
          requestedModel: llmCalls.requestedModel,
          modelUsed: llmCalls.modelUsed,
          provider: llmCalls.provider,
          status: llmCalls.status,
          errorCode: llmCalls.errorCode,
          cacheHit: llmCalls.cacheHit,
          inputTokens: llmCalls.inputTokens,
          outputTokens: llmCalls.outputTokens,
          cacheReadTokens: llmCalls.cacheReadTokens,
          cacheWriteTokens: llmCalls.cacheWriteTokens,
          costUsd: sql<number>`${llmCalls.costUsd}::float8`,
          latencyMs: llmCalls.latencyMs,
          fallbacks: sql<number>`greatest(jsonb_array_length(${llmCalls.attempts}) - 1, 0)::int`,
          createdAt: sql<string>`to_char(${llmCalls.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
        })
        .from(llmCalls)
        .where(scope)
        .orderBy(desc(llmCalls.createdAt))
        .limit(USAGE_CALL_LIMIT),
    ]);
    return { days, totals: overall[0]!, calls, limit: USAGE_CALL_LIMIT };
  };
}

export type Usage = ReturnType<typeof createUsage>;
