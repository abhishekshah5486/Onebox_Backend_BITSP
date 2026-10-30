import { currentUser, requireUser, type TokenVerifier } from '@onebox/auth-kit';
import { searchModeSchema } from '@onebox/contracts';
import { createServer, registerHealthRoutes, type HealthCheck } from '@onebox/http';
import type { Logger } from '@onebox/logger';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { EmbedClient } from './clients/embed-client';
import type { ThreadLookup } from './clients/mail-client';
import type { KeywordIndex } from './keyword/keyword-index';
import { freeText, parseQuery } from './query/parse';
import type { VectorIndex } from './semantic/vector-index';

// Meaning-based results are ranked, not paged deep: past this they stop being relevant.
const MAX_SEMANTIC_RESULTS = 100;

export interface AppDeps {
  logger: Logger;
  checks: Record<string, HealthCheck>;
  keyword: KeywordIndex;
  vector: VectorIndex;
  embed: EmbedClient;
  lookupThreads: ThreadLookup;
  verifyToken: TokenVerifier;
}

interface Hit {
  threadId: string;
  messageId: string;
  score: number | null;
  highlights: string[];
}

const searchQuery = z.object({
  q: z.string().trim().max(2_000).default(''),
  mode: searchModeSchema.default('keyword'),
  page: z.coerce.number().int().min(0).max(400).default(0),
  pageSize: z.coerce.number().int().min(1).max(50).default(25),
});

export function buildApp(deps: AppDeps) {
  const app = createServer({ logger: deps.logger });
  app.decorateRequest('user', null);
  registerHealthRoutes(app, deps.checks);
  const routes = app.withTypeProvider<ZodTypeProvider>();

  routes.get(
    '/search',
    { preHandler: requireUser(deps.verifyToken), schema: { querystring: searchQuery } },
    async (request) => {
      const { userId } = currentUser(request);
      const { q, page, pageSize } = request.query;
      const query = parseQuery(q);
      const text = freeText(query);
      // Operators alone (e.g. from:x) have nothing to compare meaning against.
      const mode = request.query.mode === 'semantic' && text ? 'semantic' : 'keyword';

      let hits: Hit[];
      let total: number;
      let more: boolean;
      if (mode === 'semantic') {
        const [vector] = await deps.embed({ userId, texts: [text], charge: true });
        const limit = Math.min((page + 1) * pageSize, MAX_SEMANTIC_RESULTS);
        const ranked = await deps.vector.search(userId, vector!, query, limit);
        hits = ranked.slice(page * pageSize).map((hit) => ({ ...hit, highlights: [] }));
        total = ranked.length;
        more = ranked.length === limit && limit < MAX_SEMANTIC_RESULTS;
      } else {
        ({ hits, total } = await deps.keyword.search(userId, query, {
          from: page * pageSize,
          size: pageSize,
        }));
        more = (page + 1) * pageSize < total;
      }

      const threads = await deps.lookupThreads(
        request.headers.authorization ?? '',
        hits.map((hit) => hit.threadId),
      );
      const byId = new Map(threads.map((thread) => [(thread as { id: string }).id, thread]));
      const items = hits.flatMap((hit) => {
        const thread = byId.get(hit.threadId);
        return thread
          ? [{ thread, messageId: hit.messageId, score: hit.score, highlights: hit.highlights }]
          : [];
      });
      return { mode, items, total, nextPage: more ? page + 1 : null };
    },
  );

  return app;
}
