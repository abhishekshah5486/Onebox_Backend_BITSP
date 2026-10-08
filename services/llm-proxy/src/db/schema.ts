import {
  boolean,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

export const llmSchema = pgSchema('llm');

export const PROVIDERS = ['OPENAI', 'GEMINI', 'ANTHROPIC'] as const;
export type Provider = (typeof PROVIDERS)[number];

// What a call is for. Each purpose has its own "Auto" route and its own user choice.
export const PURPOSES = ['classify', 'extract', 'draft', 'summarize'] as const;
export type Purpose = (typeof PURPOSES)[number];

export const providerEnum = llmSchema.enum('provider', PROVIDERS);

// The models users can pick from, best first: `rank` orders the fallback list.
export const models = llmSchema.table('models', {
  id: text('id').primaryKey(),
  provider: providerEnum('provider').notNull(),
  name: text('name').notNull(),
  description: text('description').notNull(),
  rank: integer('rank').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// "Auto" for each purpose: the models tried in order.
export const purposeRoutes = llmSchema.table(
  'purpose_routes',
  {
    purpose: text('purpose').notNull(),
    position: integer('position').notNull(),
    modelId: text('model_id')
      .notNull()
      .references(() => models.id),
  },
  (table) => [primaryKey({ columns: [table.purpose, table.position] })],
);

// A user's pick per purpose; no row means Auto.
export const userModelChoices = llmSchema.table(
  'user_model_choices',
  {
    userId: uuid('user_id').notNull(),
    purpose: text('purpose').notNull(),
    modelId: text('model_id')
      .notNull()
      .references(() => models.id),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [primaryKey({ columns: [table.userId, table.purpose] })],
);

export interface AttemptRecord {
  model: string;
  outcome: 'ok' | 'error' | 'invalid_output' | 'skipped';
  error?: string;
  latencyMs: number;
}

// One row per request: who asked, what for, which models were tried and what it took.
export const llmCalls = llmSchema.table(
  'llm_calls',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull(),
    purpose: text('purpose').notNull(),
    // The caller's own reference, e.g. a message id; never the content itself.
    subject: text('subject'),
    traceId: text('trace_id'),
    requestedModel: text('requested_model').notNull(),
    modelUsed: text('model_used'),
    provider: providerEnum('provider'),
    status: text('status').notNull(),
    errorCode: text('error_code'),
    cacheHit: boolean('cache_hit').notNull().default(false),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    latencyMs: integer('latency_ms').notNull(),
    attempts: jsonb('attempts').$type<AttemptRecord[]>().notNull(),
    requestHash: text('request_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('llm_calls_user_created_idx').on(table.userId, table.createdAt),
    index('llm_calls_created_idx').on(table.createdAt),
  ],
);

export type ModelRow = typeof models.$inferSelect;
