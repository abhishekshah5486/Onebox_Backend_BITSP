import { createRemoteTokenVerifier } from '@onebox/auth-kit';
import { ingestPayloadSchema, QUEUES } from '@onebox/contracts';
import { connectMongo } from '@onebox/db-mongo';
import { startServer, type Cleanup } from '@onebox/http';
import { createLogger } from '@onebox/logger';
import { createConsumer } from '@onebox/queue';
import { buildApp } from './app';
import { loadMailConfig } from './config';
import { ensureIndexes, mailCollections } from './db/collections';
import { createIngestHandler } from './ingest/ingest-message';
import { createMailService } from './mail/mail-service';

const logger = createLogger({ service: 'mail', pretty: process.stdout.isTTY });
const config = loadMailConfig();

const mongo = await connectMongo(config.MONGO_URI, config.MONGO_DB);
const collections = mailCollections(mongo.db);
await ensureIndexes(collections);
logger.info({ db: config.MONGO_DB }, 'mongodb connected');

const cleanups: Cleanup[] = [];
if (config.MAIL_ROLE !== 'api') {
  const consumer = createConsumer(
    QUEUES.ingest,
    ingestPayloadSchema,
    createIngestHandler(collections),
    {
      redisUrl: config.REDIS_URL,
      logger,
      concurrency: config.INGEST_CONCURRENCY,
    },
  );
  cleanups.push(consumer.close);
  logger.info({ concurrency: config.INGEST_CONCURRENCY }, 'ingest worker started');
}
cleanups.push(mongo.close);

const app = buildApp({
  logger,
  checks: { mongodb: mongo.ping },
  ...(config.MAIL_ROLE !== 'worker' && {
    routes: {
      mail: createMailService(collections),
      verifyToken: createRemoteTokenVerifier(config.AUTH_SERVICE_URL),
    },
  }),
});
await startServer(app, { port: config.PORT, cleanups });
