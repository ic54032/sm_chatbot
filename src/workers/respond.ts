import { Worker, type ConnectionOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Db } from '../db/kysely.js';
import type { GhlClient } from '../ghl/client.js';
import type { LlmClient } from '../llm/client.js';
import * as salonsRepo from '../db/repos/salons.js';
import { generateResponse } from '../core/generate-response.js';
import type { RespondJobData } from '../queue/index.js';
import { logger } from '../lib/logger.js';

export interface BuildRespondWorkerDeps {
  db: Db;
  redis: Redis;
  ghl: GhlClient;
  llm: LlmClient;
  defaultLlmModel: string;
  connection: ConnectionOptions;
}

export function buildRespondWorker(deps: BuildRespondWorkerDeps): Worker<RespondJobData> {
  return new Worker<RespondJobData>(
    'respond',
    async (job) => {
      const lockKey = `conversation:${job.data.conversationId}:lock`;
      const acquired = await deps.redis.set(lockKey, job.id ?? 'job', 'EX', 60, 'NX');
      if (acquired !== 'OK') {
        logger.info({ conversationId: job.data.conversationId }, 'lock not acquired; another worker is handling');
        return;
      }
      try {
        const salon = await salonsRepo.findById(deps.db, job.data.salonId);
        if (!salon) {
          logger.warn({ salonId: job.data.salonId }, 'salon disappeared between schedule and run; dropping');
          return;
        }
        await generateResponse(
          { db: deps.db, ghl: deps.ghl, llm: deps.llm, defaultLlmModel: deps.defaultLlmModel },
          salon,
          job.data.conversationId,
        );
      } finally {
        await deps.redis.del(lockKey);
      }
    },
    { connection: deps.connection, concurrency: 4 },
  );
}
