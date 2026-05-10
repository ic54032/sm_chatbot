import Fastify from 'fastify';
import type { Queue } from 'bullmq';
import { loadConfig } from './config.js';
import { createKyselyDb } from './db/kysely.js';
import { MockGhlClient } from './ghl/mock.js';
import type { GhlClient } from './ghl/client.js';
import { createLlmClient } from './llm/factory.js';
import type { LlmClient } from './llm/client.js';
import { logger } from './lib/logger.js';
import { inboundWebhookRoute } from './routes/webhooks-ghl-inbound.js';
import { devSimulateRoute } from './routes/dev-simulate.js';
import { adminSalonsRoute } from './routes/admin-salons.js';
import { resumeWebhookRoute } from './routes/webhooks-ghl-resume.js';
import { createConnection, createRespondQueue, redisConnectionOptions, type RespondJobData } from './queue/index.js';
import { buildRespondWorker } from './workers/respond.js';
import { setupAutoResume } from './workers/auto-resume.js';
import type { Redis } from 'ioredis';

async function main() {
  const cfg = loadConfig();
  const db = createKyselyDb(cfg.databaseUrl);
  const redis = createConnection(cfg.redisUrl);
  const llm: LlmClient = createLlmClient(cfg);
  const ghl: GhlClient = new MockGhlClient(db);

  const connection = redisConnectionOptions(cfg.redisUrl);
  const respondQueue = createRespondQueue(connection);
  const respondWorker = buildRespondWorker({
    db,
    redis,
    ghl,
    llm,
    defaultLlmModel: cfg.llmModel,
    connection,
  });

  const autoResume = await setupAutoResume({ db, ghl, connection });

  const app = Fastify({ logger: false });

  app.get('/health', async () => ({ status: 'ok', ts: new Date().toISOString() }));

  const deps = { db, redis, ghl, llm, cfg, respondQueue, defaultLlmModel: cfg.llmModel } as const;
  app.decorate('deps', deps);

  await app.register(inboundWebhookRoute);
  await app.register(devSimulateRoute);
  await app.register(adminSalonsRoute);
  await app.register(resumeWebhookRoute);

  app.setErrorHandler((err, _req, reply) => {
    logger.error({ err }, 'unhandled error');
    reply.code(500).send({ error: 'internal_error' });
  });

  await app.listen({ port: cfg.port, host: '0.0.0.0' });
  logger.info({ port: cfg.port }, 'server listening; respond worker active');

  const shutdown = async () => {
    logger.info('shutting down');
    await app.close();
    await respondWorker.close();
    await autoResume.worker.close();
    await autoResume.queue.close();
    await respondQueue.close();
    await redis.quit();
    await db.destroy();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  logger.error({ err }, 'fatal startup error');
  process.exit(1);
});

declare module 'fastify' {
  interface FastifyInstance {
    deps: {
      db: ReturnType<typeof createKyselyDb>;
      redis: Redis;
      ghl: GhlClient;
      llm: LlmClient;
      cfg: ReturnType<typeof loadConfig>;
      respondQueue: Queue<RespondJobData>;
      defaultLlmModel: string;
    };
  }
}
