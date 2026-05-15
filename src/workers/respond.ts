import { Worker, type ConnectionOptions } from 'bullmq';
import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { Db } from '../db/kysely.js';
import type { GhlFactory } from '../ghl/client.js';
import type { LlmClient } from '../llm/client.js';
import * as salonsRepo from '../db/repos/salons.js';
import { generateResponse } from '../core/generate-response.js';
import type { RespondJobData } from '../queue/index.js';
import { logger } from '../lib/logger.js';

const LOCK_TTL_SECONDS = 180;

// Conditional release: only delete the lock if we still own it.
// Prevents an expired-lock-takeover scenario where worker A's `finally`
// would otherwise delete worker B's freshly acquired lock.
const RELEASE_LOCK_LUA = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

export interface BuildRespondWorkerDeps {
  db: Db;
  redis: Redis;
  ghlFor: GhlFactory;
  llm: LlmClient;
  defaultLlmModel: string;
  connection: ConnectionOptions;
  encryptionKey?: string;
}

export function buildRespondWorker(deps: BuildRespondWorkerDeps): Worker<RespondJobData> {
  return new Worker<RespondJobData>(
    'respond',
    async (job) => {
      const lockKey = `conversation:${job.data.conversationId}:lock`;
      const lockToken = randomUUID();

      const acquired = await deps.redis.set(lockKey, lockToken, 'EX', LOCK_TTL_SECONDS, 'NX');
      if (acquired !== 'OK') {
        logger.info({ conversationId: job.data.conversationId }, 'lock not acquired; another worker is handling');
        return;
      }
      try {
        const salon = await salonsRepo.findById(deps.db, job.data.salonId, deps.encryptionKey);
        if (!salon) {
          logger.warn({ salonId: job.data.salonId }, 'salon disappeared between schedule and run; dropping');
          return;
        }
        const ghl = deps.ghlFor(salon);
        await generateResponse(
          { db: deps.db, ghl, llm: deps.llm, defaultLlmModel: deps.defaultLlmModel },
          salon,
          job.data.conversationId,
        );
      } finally {
        // Only release if we still own the lock (token match).
        await deps.redis.eval(RELEASE_LOCK_LUA, 1, lockKey, lockToken).catch((err) => {
          logger.warn({ err, conversationId: job.data.conversationId }, 'lock release failed');
        });
      }
    },
    { connection: deps.connection, concurrency: 4 },
  );
}
