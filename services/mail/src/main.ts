import { createBlobStore } from '@onebox/blob-store';
import { createRemoteTokenVerifier, deriveInternalToken } from '@onebox/auth-kit';
import {
  type AiClassifyPayload,
  ingestPayloadSchema,
  mailboxChangePayloadSchema,
  QUEUES,
  type HistoryPayload,
  type IndexPayload,
  liveChannel,
  type MailboxOpPayload,
  type SendPayload,
} from '@onebox/contracts';
import { connectMongo } from '@onebox/db-mongo';
import { startServer, type Cleanup } from '@onebox/http';
import { createLogger } from '@onebox/logger';
import { createMailboxStore } from '@onebox/mailbox-state';
import { createConsumer, createProducer } from '@onebox/queue';
import { Redis } from 'ioredis';
import { buildApp } from './app';
import { loadMailConfig } from './config';
import { ensureIndexes, mailCollections } from './db/collections';
import { aiJob } from './ingest/ai-job';
import { createAttachmentService } from './attachments/attachments';
import { createAccountsClient } from './compose/accounts-client';
import { composeCollections, ensureComposeIndexes } from './compose/collections';
import { createComposeService } from './compose/compose-service';
import { googleDriveUploader } from './storage/google-drive';
import { dropboxUploader } from './storage/dropbox';
import { azureBlobUploader, s3Uploader } from './storage/object-store';
import { oneDriveUploader } from './storage/onedrive';
import { createStorageService } from './storage/storage';
import { createIngestHandler } from './ingest/ingest-message';
import { createMailService } from './mail/mail-service';
import { createMailboxService } from './mail/mailbox-service';
import { createLabelService } from './mail/label-service';
import { createThreadActions } from './mail/thread-actions';
import { createChangesHandler } from './sync/apply-changes';
import { labelWriter } from './sync/write-labels';
import { enableThreadPreImages, startLiveFeed } from './feed/live-feed';
import { startSearchFeed } from './feed/search-feed';
import { refreshStoredText } from './ingest/refresh-text';
import { backfillAttachmentRefs, migrateFolderRoles } from './threads/thread-store';

const logger = createLogger({ service: 'mail', pretty: process.stdout.isTTY });
const config = loadMailConfig();

// Attachment contents live in an S3-compatible store (SeaweedFS locally).
const blobs = createBlobStore(config);
await blobs.ensureBucket();

const mongo = await connectMongo(config.MONGO_URI, config.MONGO_DB, {
  onRetry: (err, attempt) =>
    logger.warn({ err: (err as Error).message, attempt }, 'mongodb not reachable yet, retrying'),
});
const collections = mailCollections(mongo.db);
await ensureIndexes(collections);
logger.info({ db: config.MONGO_DB }, 'mongodb connected');
const migrated = await migrateFolderRoles(collections);
if (migrated > 0) logger.info({ threads: migrated }, 'conversations tagged with folders');
const retexted = await refreshStoredText(collections);
if (retexted > 0) logger.info({ messages: retexted }, 'snippets cleaned of html and padding');

const cleanups: Cleanup[] = [];
const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 3 });
redis.on('error', (err) => logger.warn({ err: err.message }, 'redis error'));
const historyProducer = createProducer<HistoryPayload>(QUEUES.history, {
  redisUrl: config.REDIS_URL,
  logger,
});
const opsProducer = createProducer<MailboxOpPayload>(QUEUES.mailboxOps, {
  redisUrl: config.REDIS_URL,
  logger,
});
cleanups.push(historyProducer.close, opsProducer.close, () => redis.quit());

const mailboxStore = createMailboxStore(redis);

const attachments = createAttachmentService({ collections, blobs, ops: opsProducer, logger });

// Compose needs the accounts service to check who owns the sending account.
const internalToken = config.CREDENTIALS_ENCRYPTION_KEY
  ? deriveInternalToken(config.CREDENTIALS_ENCRYPTION_KEY)
  : null;
const sends = createProducer<SendPayload>(QUEUES.send, { redisUrl: config.REDIS_URL, logger });
cleanups.push(sends.close);
const composeStore = composeCollections(mongo.db);
await ensureComposeIndexes(composeStore);
const compose = internalToken
  ? createComposeService({
      collections: composeStore,
      mail: collections,
      blobs,
      attachments,
      accounts: createAccountsClient(config.ACCOUNTS_SERVICE_URL, internalToken),
      sends,
      logger,
    })
  : null;

if (config.MAIL_ROLE !== 'api') {
  // New inbox mail goes to the ai service to be sorted into the user's labels.
  const aiProducer = createProducer<AiClassifyPayload>(QUEUES.ai, {
    redisUrl: config.REDIS_URL,
    logger,
  });
  cleanups.push(aiProducer.close);
  const consumer = createConsumer(
    QUEUES.ingest,
    ingestPayloadSchema,
    createIngestHandler(
      collections,
      async (doc) => {
        await aiProducer.enqueue(aiJob(doc));
      },
      blobs,
    ),
    {
      redisUrl: config.REDIS_URL,
      logger,
      concurrency: config.INGEST_CONCURRENCY,
    },
  );
  // One at a time: changes for the same folder must apply in the order the server made them.
  const changes = createConsumer(
    QUEUES.mailboxChanges,
    mailboxChangePayloadSchema,
    createChangesHandler(
      collections,
      async (outboxId, status, error) => {
        await compose?.applyResult(outboxId, status, error);
      },
      labelWriter(opsProducer),
    ),
    { redisUrl: config.REDIS_URL, logger, concurrency: 1 },
  );
  cleanups.push(consumer.close, changes.close);

  // Live updates for open apps, and keeping search's indexes in step with stored mail.
  await enableThreadPreImages(mongo.db);
  const live = startLiveFeed({
    threads: collections.threads,
    publish: (userId, event) => redis.publish(liveChannel(userId), JSON.stringify(event)),
    logger,
  });
  const indexProducer = createProducer<IndexPayload>(QUEUES.index, {
    redisUrl: config.REDIS_URL,
    logger,
  });
  const embedProducer = createProducer<IndexPayload>(QUEUES.embed, {
    redisUrl: config.REDIS_URL,
    logger,
  });
  const searchFeed = startSearchFeed({
    db: mongo.db,
    messages: collections.messages,
    redis,
    queues: [indexProducer, embedProducer],
    logger,
  });
  cleanups.push(live.close, searchFeed.close, indexProducer.close, embedProducer.close);
  logger.info({ concurrency: config.INGEST_CONCURRENCY }, 'ingest worker started');
  void backfillAttachmentRefs(collections)
    .then((count) => count > 0 && logger.info({ count }, 'attachment lists added to older threads'))
    .catch((err: unknown) => logger.warn({ err }, 'attachment list backfill failed'));
}
cleanups.push(mongo.close);

const app = buildApp({
  logger,
  checks: { mongodb: mongo.ping, redis: () => redis.ping() },
  ...(config.MAIL_ROLE !== 'worker' && {
    routes: {
      mail: createMailService(collections),
      mailboxes: createMailboxService({
        collections,
        store: mailboxStore,
        historyProducer,
        logger,
      }),
      actions: createThreadActions({ collections, ops: opsProducer, logger }),
      labels: createLabelService({ store: mailboxStore, ops: opsProducer, logger }),
      attachments,
      ...(config.CREDENTIALS_ENCRYPTION_KEY && {
        storage: createStorageService({
          attachments,
          settingsUrl: config.SETTINGS_SERVICE_URL,
          internalToken: deriveInternalToken(config.CREDENTIALS_ENCRYPTION_KEY),
          logger,
          uploaders: {
            GOOGLE_DRIVE: googleDriveUploader(logger),
            ONEDRIVE: oneDriveUploader(logger),
            DROPBOX: dropboxUploader(logger),
            S3: s3Uploader(logger),
            AZURE_BLOB: azureBlobUploader(logger),
          },
        }),
      }),
      ...(compose && { compose }),
      verifyToken: createRemoteTokenVerifier(config.AUTH_SERVICE_URL),
    },
  }),
});
await startServer(app, { port: config.PORT, cleanups });
