import { z } from 'zod';

// One setting a vector store's form asks for. "address" fields name a server, so they are
// checked against private networks before OneBox connects.
export interface VectorStoreField {
  key: string;
  label: string;
  secret: boolean;
  required: boolean;
  address: boolean;
  placeholder?: string;
  default?: string;
}

export interface VectorStoreInfo {
  id: VectorStoreId;
  name: string;
  description: string;
  docsUrl: string;
  // Simple Icons slug for its logo, where there is one.
  icon: string | null;
  fields: VectorStoreField[];
}

const field = (
  key: string,
  label: string,
  options: Partial<Omit<VectorStoreField, 'key' | 'label'>> = {},
): VectorStoreField => ({
  key,
  label,
  secret: false,
  required: true,
  address: false,
  ...options,
});
const url = (placeholder: string) => field('url', 'URL', { address: true, placeholder });
const apiKey = (required = false) => field('apiKey', 'API key', { secret: true, required });

// Vector databases a user can keep their search vectors in. Each needs an adapter in
// @onebox/vector-stores; the order is the order they're offered in.
export const VECTOR_STORES = [
  {
    id: 'QDRANT',
    name: 'Qdrant',
    description: 'Qdrant Cloud or your own server',
    docsUrl: 'https://qdrant.tech/documentation/cloud/authentication/',
    icon: 'qdrant',
    fields: [url('https://xyz.cloud.qdrant.io:6333'), apiKey()],
  },
  {
    id: 'PINECONE',
    name: 'Pinecone',
    description: 'Serverless indexes, one namespace per user',
    docsUrl: 'https://docs.pinecone.io/guides/projects/manage-api-keys',
    icon: null,
    fields: [
      apiKey(true),
      field('cloud', 'Cloud', { default: 'aws' }),
      field('region', 'Region', { default: 'us-east-1' }),
      field('controllerHost', 'API host', {
        required: false,
        address: true,
        placeholder: 'Leave empty for Pinecone’s own',
      }),
    ],
  },
  {
    id: 'WEAVIATE',
    name: 'Weaviate',
    description: 'Weaviate Cloud or your own server',
    docsUrl: 'https://weaviate.io/developers/wcs/connect',
    icon: null,
    fields: [
      url('https://xyz.weaviate.cloud'),
      field('grpcUrl', 'gRPC URL', {
        required: false,
        address: true,
        placeholder: 'For your own server, e.g. http://host:50051',
      }),
      apiKey(),
    ],
  },
  {
    id: 'MILVUS',
    name: 'Milvus / Zilliz Cloud',
    description: 'Milvus or its managed Zilliz Cloud',
    docsUrl: 'https://docs.zilliz.com/docs/manage-cluster-credentials',
    icon: 'milvus',
    fields: [
      field('address', 'Address', { address: true, placeholder: 'https://xyz.zillizcloud.com' }),
      field('token', 'Token', { secret: true, required: false }),
    ],
  },
  {
    id: 'CHROMA',
    name: 'Chroma',
    description: 'Your own Chroma server',
    docsUrl: 'https://docs.trychroma.com/deployment',
    icon: null,
    fields: [url('http://chroma.example.com:8000'), apiKey()],
  },
  {
    id: 'PGVECTOR',
    name: 'Postgres (pgvector)',
    description: 'Any Postgres with pgvector, e.g. Supabase or Neon',
    docsUrl: 'https://github.com/pgvector/pgvector',
    icon: 'postgresql',
    fields: [
      field('connectionString', 'Connection string', {
        secret: true,
        address: true,
        placeholder: 'postgres://user:password@host:5432/db',
      }),
    ],
  },
  {
    id: 'ELASTICSEARCH',
    name: 'Elasticsearch',
    description: 'Elastic Cloud or your own cluster',
    docsUrl: 'https://www.elastic.co/docs/deploy-manage/api-keys',
    icon: 'elasticsearch',
    fields: [url('https://xyz.es.io:443'), apiKey()],
  },
  {
    id: 'OPENSEARCH',
    name: 'OpenSearch',
    description: 'Amazon OpenSearch or your own cluster',
    docsUrl: 'https://docs.opensearch.org/latest/security/',
    icon: 'opensearch',
    fields: [
      url('https://search.example.com:9200'),
      field('username', 'Username', { required: false }),
      field('password', 'Password', { secret: true, required: false }),
    ],
  },
  {
    id: 'MONGODB_ATLAS',
    name: 'MongoDB Atlas',
    description: 'Atlas Vector Search',
    docsUrl: 'https://www.mongodb.com/docs/atlas/atlas-vector-search/',
    icon: 'mongodb',
    fields: [
      field('connectionString', 'Connection string', {
        secret: true,
        address: true,
        placeholder: 'mongodb+srv://user:password@cluster.mongodb.net',
      }),
      field('database', 'Database', { default: 'onebox' }),
    ],
  },
  {
    id: 'REDIS',
    name: 'Redis',
    description: 'Redis 8 or Redis Cloud with search',
    docsUrl: 'https://redis.io/docs/latest/develop/ai/search-and-query/vectors/',
    icon: 'redis',
    fields: [
      field('url', 'URL', {
        secret: true,
        address: true,
        placeholder: 'rediss://default:password@host:6379',
      }),
    ],
  },
  {
    id: 'NEO4J',
    name: 'Neo4j',
    description: 'Neo4j AuraDB or your own server',
    docsUrl:
      'https://neo4j.com/docs/cypher-manual/current/indexes/semantic-indexes/vector-indexes/',
    icon: 'neo4j',
    fields: [
      field('url', 'URL', { address: true, placeholder: 'neo4j+s://xyz.databases.neo4j.io' }),
      field('username', 'Username', { default: 'neo4j' }),
      field('password', 'Password', { secret: true }),
      field('database', 'Database', { required: false, placeholder: 'neo4j' }),
    ],
  },
] as const satisfies readonly (Omit<VectorStoreInfo, 'id'> & { id: string })[];

export type VectorStoreId = (typeof VECTOR_STORES)[number]['id'];
export const VECTOR_STORE_IDS = VECTOR_STORES.map((store) => store.id) as [
  VectorStoreId,
  ...VectorStoreId[],
];
export const vectorStoreInfo = (id: VectorStoreId): VectorStoreInfo =>
  VECTOR_STORES.find((store) => store.id === id) as VectorStoreInfo;

// What search gets to reach a user's own store: its kind and every setting, secrets included.
export const vectorStoreConnectionSchema = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('ONEBOX') }),
  z.object({
    provider: z.enum(VECTOR_STORE_IDS),
    settings: z.record(z.string(), z.string()),
  }),
]);
export type VectorStoreConnection = z.infer<typeof vectorStoreConnectionSchema>;

// OneBox's own store, which every user has and can pause but not remove.
export const ONEBOX_STORE_ID = 'onebox';

// Every store a user keeps vectors in, as search reads it from settings: secrets included,
// paused ones get no new mail, and one of them answers searches.
export const vectorStoreSetupSchema = z.object({
  searchStoreId: z.string().min(1),
  stores: z.array(
    z.intersection(
      z.object({ id: z.string().min(1), paused: z.boolean() }),
      vectorStoreConnectionSchema,
    ),
  ),
});
export type VectorStoreSetup = z.infer<typeof vectorStoreSetupSchema>;
export type ConfiguredVectorStore = VectorStoreSetup['stores'][number];
