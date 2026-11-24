import type { VectorStoreId } from '@onebox/contracts';
import { chromaStore } from './chroma';
import { milvusStore } from './milvus';
import { mongodbStore } from './mongodb';
import { neo4jStore } from './neo4j';
import { pgvectorStore } from './pgvector';
import { pineconeStore } from './pinecone';
import { qdrantCheck } from './qdrant';
import { redisStore } from './redis';
import { elasticsearchStore, openSearchStore } from './search-engines';
import { StoreCheckError, type VectorStore } from './types';
import { weaviateStore } from './weaviate';

export * from './types';

// Every store but Qdrant, which search talks to natively.
const OPENERS: Record<
  Exclude<VectorStoreId, 'QDRANT'>,
  (settings: Record<string, string>) => VectorStore
> = {
  PINECONE: pineconeStore,
  WEAVIATE: weaviateStore,
  MILVUS: milvusStore,
  CHROMA: chromaStore,
  PGVECTOR: pgvectorStore,
  ELASTICSEARCH: elasticsearchStore,
  OPENSEARCH: openSearchStore,
  MONGODB_ATLAS: mongodbStore,
  REDIS: redisStore,
  NEO4J: neo4jStore,
};

export function openVectorStore(
  provider: Exclude<VectorStoreId, 'QDRANT'>,
  settings: Record<string, string>,
) {
  return OPENERS[provider](settings);
}

// Connects with the settings given and makes one authenticated call; throws StoreCheckError
// with a readable reason when that fails.
export async function checkVectorStore(
  provider: VectorStoreId,
  settings: Record<string, string>,
  timeoutMs = 20_000,
) {
  const store = provider === 'QDRANT' ? qdrantCheck(settings) : openVectorStore(provider, settings);
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      store.check(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new StoreCheckError('The store took too long to answer')),
          timeoutMs,
        );
      }),
    ]);
  } catch (err) {
    if (err instanceof StoreCheckError) throw err;
    throw new StoreCheckError(describe(err));
  } finally {
    clearTimeout(timer);
    await store.close().catch(() => {});
  }
}

// The gist of a driver error, without stack or request dumps.
function describe(err: unknown) {
  // fetch and some drivers keep the real reason (e.g. ECONNREFUSED) in a chain of causes.
  const parts: string[] = [];
  for (let at: unknown = err, depth = 0; at && depth < 5; depth += 1) {
    const e = at as { message?: string; code?: string; cause?: unknown };
    parts.push([e.code, e.message ?? (typeof at === 'string' ? at : '')].filter(Boolean).join(' '));
    at = e.cause;
  }
  const message = parts.join(': ');
  if (
    /401|403|unauthori[sz]ed|forbidden|authentication|invalid api key|auth fail|WRONGPASS|NOAUTH|permission/i.test(
      message,
    )
  ) {
    return 'The store rejected these credentials';
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(message)) return "Couldn't find that host";
  if (
    /ECONNREFUSED|ETIMEDOUT|timed? ?out|unavailable|ECONNRESET|failed to connect/i.test(message)
  ) {
    return "Couldn't reach the store";
  }
  return `The store answered with an error: ${message.slice(0, 160)}`;
}
