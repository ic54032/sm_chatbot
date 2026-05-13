import Fastify, { type FastifyInstance } from 'fastify';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import type { Kysely } from 'kysely';
import type { Database } from '../../src/db/schema.js';
import { MockGhlClient } from '../../src/ghl/mock.js';
import type { GhlFactory } from '../../src/ghl/client.js';
import { inboundWebhookRoute } from '../../src/routes/webhooks-ghl-inbound.js';
import { devSimulateRoute } from '../../src/routes/dev-simulate.js';
import { adminSalonsRoute } from '../../src/routes/admin-salons.js';
import { resumeWebhookRoute } from '../../src/routes/webhooks-ghl-resume.js';
import { buildRespondWorker } from '../../src/workers/respond.js';
import type { RespondJobData } from '../../src/queue/index.js';
import type { LlmClient } from '../../src/llm/client.js';

const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:56379';

export interface TestApp {
  app: FastifyInstance;
  queue: Queue<RespondJobData>;
  worker: Worker<RespondJobData>;
  ghl: MockGhlClient;
  redis: Redis;
  shutdown: () => Promise<void>;
}

export async function buildTestApp(db: Kysely<Database>, llm: LlmClient): Promise<TestApp> {
  const url = new URL(REDIS_URL);
  const connection = { host: url.hostname, port: Number(url.port || 6379) };

  const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
  const queue = new Queue<RespondJobData>('respond', { connection });
  const ghl = new MockGhlClient(db);
  const ghlFor: GhlFactory = () => ghl;
  const defaultLlmModel = 'fake-model';
  const worker = buildRespondWorker({ db, redis, ghlFor, llm, defaultLlmModel, connection });

  const cfg = {
    port: 0,
    nodeEnv: 'test' as const,
    logLevel: 'silent' as const,
    databaseUrl: '',
    redisUrl: REDIS_URL,
    webhookSecret: 'test-secret',
    adminApiKey: 'test-admin',
    llmProvider: 'anthropic' as const,
    anthropicApiKey: 'unused',
    openaiApiKey: undefined,
    geminiApiKey: undefined,
    llmModel: defaultLlmModel,
  };

  const app = Fastify({ logger: false });
  app.decorate('deps', { db, redis, ghlFor, mockGhl: ghl, llm, cfg, respondQueue: queue, defaultLlmModel });

  await app.register(inboundWebhookRoute);
  await app.register(devSimulateRoute);
  await app.register(adminSalonsRoute);
  await app.register(resumeWebhookRoute);

  return {
    app,
    queue,
    worker,
    ghl,
    redis,
    shutdown: async () => {
      await app.close();
      await worker.close();
      await queue.close();
      await redis.quit();
      await new Promise((r) => setTimeout(r, 100));
    },
  };
}
