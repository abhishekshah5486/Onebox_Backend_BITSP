import { and, desc, eq, gte, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { llmCalls } from '../db/schema';

// What a user's AI use came to: totals, per model, per purpose and per day.
export function createUsage(db: PostgresJsDatabase) {
  const totals = {
    calls: sql<number>`count(*)::int`,
    inputTokens: sql<number>`coalesce(sum(${llmCalls.inputTokens}), 0)::int`,
    outputTokens: sql<number>`coalesce(sum(${llmCalls.outputTokens}), 0)::int`,
    cacheHits: sql<number>`count(*) filter (where ${llmCalls.cacheHit})::int`,
    failures: sql<number>`count(*) filter (where ${llmCalls.status} = 'failed')::int`,
  };

  return async function summary(userId: string, days: number) {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const scope = and(eq(llmCalls.userId, userId), gte(llmCalls.createdAt, since));
    const day = sql<string>`to_char(date_trunc('day', ${llmCalls.createdAt}), 'YYYY-MM-DD')`;

    const [overall, byModel, byPurpose, daily, recent] = await Promise.all([
      db.select(totals).from(llmCalls).where(scope),
      db
        .select({ model: sql<string>`coalesce(${llmCalls.modelUsed}, 'none')`, ...totals })
        .from(llmCalls)
        .where(scope)
        .groupBy(llmCalls.modelUsed)
        .orderBy(desc(totals.calls)),
      db
        .select({ purpose: llmCalls.purpose, ...totals })
        .from(llmCalls)
        .where(scope)
        .groupBy(llmCalls.purpose)
        .orderBy(desc(totals.calls)),
      db
        .select({ day, ...totals })
        .from(llmCalls)
        .where(scope)
        .groupBy(day)
        .orderBy(day),
      db
        .select({
          id: llmCalls.id,
          purpose: llmCalls.purpose,
          requestedModel: llmCalls.requestedModel,
          modelUsed: llmCalls.modelUsed,
          status: llmCalls.status,
          cacheHit: llmCalls.cacheHit,
          inputTokens: llmCalls.inputTokens,
          outputTokens: llmCalls.outputTokens,
          latencyMs: llmCalls.latencyMs,
          fallbacks: sql<number>`greatest(jsonb_array_length(${llmCalls.attempts}) - 1, 0)::int`,
          createdAt: sql<string>`${llmCalls.createdAt}::text`,
        })
        .from(llmCalls)
        .where(scope)
        .orderBy(desc(llmCalls.createdAt))
        .limit(50),
    ]);
    return { days, totals: overall[0]!, byModel, byPurpose, daily, recent };
  };
}

export type Usage = ReturnType<typeof createUsage>;
