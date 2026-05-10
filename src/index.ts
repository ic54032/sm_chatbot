import Fastify from 'fastify';
import { Redis } from 'ioredis';
import { loadConfig } from './config.js';
import { createKyselyDb } from './db/kysely.js';
import { MockGhlClient } from './ghl/mock.js';
import type { GhlClient } from './ghl/client.js';
import { AnthropicLlmClient } from './llm/client.js';
import type { LlmClient } from './llm/client.js';
import { logger } from './lib/logger.js';
import { inboundWebhookRoute } from './routes/webhooks-ghl-inbound.js';
import { devSimulateRoute } from './routes/dev-simulate.js';
import { adminSalonsRoute } from './routes/admin-salons.js';

async function main() {
  const cfg = loadConfig();
  const db = createKyselyDb(cfg.databaseUrl);
  const redis = new Redis(cfg.redisUrl);
  const llm: LlmClient = new AnthropicLlmClient(cfg.anthropicApiKey);
  const ghl: GhlClient = new MockGhlClient(db);

  const app = Fastify({ logger: false });

  app.get('/health', async () => ({ status: 'ok', ts: new Date().toISOString() }));

  const deps = { db, redis, ghl, llm, cfg } as const;
  app.decorate('deps', deps);

  await app.register(inboundWebhookRoute);
  await app.register(devSimulateRoute);
  await app.register(adminSalonsRoute);

  app.setErrorHandler((err, _req, reply) => {
    logger.error({ err }, 'unhandled error');
    reply.code(500).send({ error: 'internal_error' });
  });

  await app.listen({ port: cfg.port, host: '0.0.0.0' });
  logger.info({ port: cfg.port }, 'server listening');

  const shutdown = async () => {
    logger.info('shutting down');
    await app.close();
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
    };
  }
}
