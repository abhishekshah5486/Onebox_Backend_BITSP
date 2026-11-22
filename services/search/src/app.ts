import { currentUser, requireInternal, requireUser, type TokenVerifier } from '@onebox/auth-kit';
import { searchModeSchema } from '@onebox/contracts';
import { createServer, registerHealthRoutes, type HealthCheck } from '@onebox/http';
import type { Logger } from '@onebox/logger';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { EmbedClient } from './clients/embed-client';
import type { ThreadLookup } from './clients/mail-client';
import type { KeywordIndex } from './keyword/keyword-index';
import { freeText, parseQuery } from './query/parse';
import type { SemanticModels } from './semantic/models';
import { embeddingText } from './semantic/vector-index';

// Emails embedded to time a model before switching to it.
const ESTIMATE_SAMPLE = 16;
// Meaning-based results are ranked, not paged deep: past this they stop being relevant.
const MAX_SEMANTIC_RESULTS = 100;

export interface AppDeps {
  logger: Logger;
  checks: Record<string, HealthCheck>;
  keyword: KeywordIndex;
  models: SemanticModels;
  embed: EmbedClient;
  lookupThreads: ThreadLookup;
  verifyToken: TokenVerifier;
  internalToken: string;
  // Queues embedding a user's mail again with their model, into their current store.
  rebuild: (userId: string) => Promise<void>;
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
        // The model the user's mail is embedded with (which may trail a fresh pick), in their store.
        const { model, index } = await deps.models.searchTarget(userId);
        const [vector] = await deps.embed({ userId, texts: [text], charge: true, model: model.id });
        const limit = Math.min((page + 1) * pageSize, MAX_SEMANTIC_RESULTS);
        const ranked = await index.search(userId, vector!, query, limit);
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

  // How long switching to a model would take: a sample of the user's own mail is timed with it.
  // The first page also wakes the model (a local one loads into memory), so the second is timed.
  routes.get(
    '/search/semantic/estimate',
    {
      preHandler: requireUser(deps.verifyToken),
      schema: { querystring: z.object({ model: z.string().min(1).max(200) }) },
    },
    async (request) => {
      const { userId } = currentUser(request);
      const emails = await deps.keyword.countOf(userId);
      const pages = deps.keyword.documentsOf(userId, ESTIMATE_SAMPLE);
      let timedMs = 0;
      let timed = 0;
      for (let round = 0; round < 2; round += 1) {
        const { value: page } = await pages.next();
        if (!page) break;
        const texts = page.map(({ doc }) => embeddingText(doc));
        const started = performance.now();
        await deps.embed({ userId, texts, charge: false, model: request.query.model });
        [timedMs, timed] = [performance.now() - started, texts.length];
      }
      await pages.return(undefined);
      const seconds = timed ? Math.ceil(((timedMs / timed) * emails) / 1000) : 0;
      return { emails, seconds };
    },
  );

  // Which model semantic search uses for the user, and how far a switch to another has got.
  // Settings calls this when a user moves their vectors to another store.
  routes.post(
    '/internal/semantic/rebuild',
    {
      preHandler: requireInternal(deps.internalToken),
      schema: { body: z.object({ userId: z.uuid() }) },
    },
    async (request, reply) => {
      deps.models.forgetStore(request.body.userId);
      await deps.rebuild(request.body.userId);
      return reply.code(202).send();
    },
  );

  routes.get('/search/semantic', { preHandler: requireUser(deps.verifyToken) }, async (request) => {
    const { userId } = currentUser(request);
    const [active, rebuild] = await Promise.all([
      deps.models.active(userId),
      deps.models.rebuildOf(userId),
    ]);
    return { active, rebuild };
  });

  return app;
}
