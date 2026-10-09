import { NotFoundError, ValidationError } from '@onebox/errors';
import { and, asc, eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  models,
  purposeRoutes,
  userModelChoices,
  type ModelRow,
  type Provider,
  type Purpose,
} from '../db/schema';

export const AUTO = 'auto';

// The catalogue and Auto routes change only with a migration, and the database is a slow
// round trip away, so they are read once a minute rather than on every request.
const CATALOG_TTL_MS = 60_000;

// The catalogue, the user's pick per purpose, and the order models are tried in.
export function createCatalog(db: PostgresJsDatabase, configured: Set<Provider>) {
  const available = (model: ModelRow) => model.enabled && configured.has(model.provider);

  let cached: { at: number; models: Promise<ModelRow[]>; routes: Promise<RouteRow[]> } | null =
    null;
  function load() {
    if (!cached || Date.now() - cached.at > CATALOG_TTL_MS) {
      const fresh = {
        at: Date.now(),
        models: db.select().from(models).orderBy(asc(models.provider), asc(models.rank)),
        routes: db
          .select()
          .from(purposeRoutes)
          .orderBy(asc(purposeRoutes.purpose), asc(purposeRoutes.position)),
      };
      // A failed read is not kept, so the next request tries again.
      Promise.all([fresh.models, fresh.routes]).catch(() => {
        if (cached === fresh) cached = null;
      });
      cached = fresh;
    }
    return cached;
  }
  const all = () => load().models;

  async function choiceOf(userId: string, purpose: Purpose) {
    const [row] = await db
      .select()
      .from(userModelChoices)
      .where(and(eq(userModelChoices.userId, userId), eq(userModelChoices.purpose, purpose)));
    return row?.modelId ?? AUTO;
  }

  return {
    async list() {
      return (await all()).map((model) => ({
        id: model.id,
        provider: model.provider,
        name: model.name,
        description: model.description,
        available: available(model),
        prices: {
          input: model.inputPrice,
          output: model.outputPrice,
          cacheRead: model.cacheReadPrice,
          cacheWrite: model.cacheWritePrice,
        },
      }));
    },

    choiceOf,

    async choices(userId: string) {
      const rows = await db
        .select()
        .from(userModelChoices)
        .where(eq(userModelChoices.userId, userId));
      return Object.fromEntries(rows.map((row) => [row.purpose, row.modelId]));
    },

    async choose(userId: string, purpose: Purpose, modelId: string) {
      if (modelId === AUTO) {
        await db
          .delete(userModelChoices)
          .where(and(eq(userModelChoices.userId, userId), eq(userModelChoices.purpose, purpose)));
        return;
      }
      const model = (await all()).find((row) => row.id === modelId);
      if (!model) throw new NotFoundError('Unknown model');
      if (!available(model)) throw new ValidationError(`${model.name} is not available right now`);
      await db
        .insert(userModelChoices)
        .values({ userId, purpose, modelId })
        .onConflictDoUpdate({
          target: [userModelChoices.userId, userModelChoices.purpose],
          set: { modelId },
        });
    },

    // The chosen model, then its provider's next models best first, then the purpose's Auto
    // route, so even a whole provider being down still gets an answer. Unavailable ones are left out.
    async chain(purpose: Purpose, requested: string): Promise<ModelRow[]> {
      const catalogue = await all();
      const byId = new Map(catalogue.map((model) => [model.id, model]));
      const route = (await load().routes)
        .filter((row) => row.purpose === purpose)
        .map((row) => byId.get(row.modelId)!);

      const picked = byId.get(requested);
      const ordered =
        requested === AUTO || !picked
          ? route
          : [
              picked,
              ...catalogue.filter((m) => m.provider === picked.provider && m.rank > picked.rank),
              ...route,
            ];
      const seen = new Set<string>();
      return ordered.filter((model) => {
        if (!available(model) || seen.has(model.id)) return false;
        seen.add(model.id);
        return true;
      });
    },
  };
}

type RouteRow = typeof purposeRoutes.$inferSelect;

export type Catalog = ReturnType<typeof createCatalog>;
