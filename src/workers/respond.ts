import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { Db } from '../db/kysely.js';
import type { GhlFactory } from '../ghl/client.js';
import type { LlmClient } from '../llm/client.js';
import * as salonsRepo from '../db/repos/salons.js';
import * as messagesRepo from '../db/repos/messages.js';
import { generateResponse } from '../core/generate-response.js';
import type { fetchAttachment as defaultFetchAttachment } from '../images/fetch.js';
import type { RespondJobData } from '../queue/index.js';
import { logger } from '../lib/logger.js';

// A drain re-enqueue: covers a message that arrived mid-processing (the
// text+photo coalescing race) or a turn that lost the conversation lock. A
// stable per-conversation jobId so repeat drains coalesce into one. It uses a
// distinct id-space from the normal respond job; that is safe because
// generateResponse's answered-guard turns any redundant run into a no-op.
const DRAIN_DELAY_MS = 3000;

async function enqueueDrain(
  queue: Queue<RespondJobData>,
  conversationId: string,
  salonId: string,
): Promise<void> {
  await queue.add(
    'respond',
    { conversationId, salonId },
    { jobId: `respond-drain-${conversationId}`, delay: DRAIN_DELAY_MS, removeOnComplete: true, removeOnFail: 10 },
  );
}

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
  fetchAttachment?: typeof defaultFetchAttachment;
  /** Same queue used by handle-inbound, so the worker can re-enqueue a drain job
   * when a message arrived mid-processing (B6). */
  respondQueue: Queue<RespondJobData>;
}

export function buildRespondWorker(deps: BuildRespondWorkerDeps): Worker<RespondJobData> {
  return new Worker<RespondJobData>(
    'respond',
    async (job) => {
      const lockKey = `conversation:${job.data.conversationId}:lock`;
      const lockToken = randomUUID();

      const acquired = await deps.redis.set(lockKey, lockToken, 'EX', LOCK_TTL_SECONDS, 'NX');
      if (acquired !== 'OK') {
        // Another worker holds the lock. Do not drop this turn: re-enqueue a
        // drain so it is retried after the current holder finishes. If the
        // holder already answered everything, the answered-guard makes the
        // drain a no-op.
        logger.info(
          { conversationId: job.data.conversationId },
          'lock not acquired; re-enqueuing drain so the turn is not dropped',
        );
        await enqueueDrain(deps.respondQueue, job.data.conversationId, job.data.salonId);
        return;
      }
      try {
        const salon = await salonsRepo.findById(deps.db, job.data.salonId, deps.encryptionKey);
        if (!salon) {
          logger.warn({ salonId: job.data.salonId }, 'salon disappeared between schedule and run; dropping');
          return;
        }
        const ghl = deps.ghlFor(salon);
        // Swallow any unexpected throw: a failed turn must drop the turn, never
        // wedge the conversation or become a poison-retry loop. generateResponse
        // already handles its own escalation/degradation paths internally; this
        // is the last-resort net for a truly unexpected error.
        try {
          const result = await generateResponse(
            {
              db: deps.db,
              ghl,
              llm: deps.llm,
              defaultLlmModel: deps.defaultLlmModel,
              fetchAttachment: deps.fetchAttachment,
            },
            salon,
            job.data.conversationId,
          );

          // B6 drain: if a message arrived while we were processing (the
          // text+photo coalescing race, where the second message's job was a
          // no-op against the already-active job), it was NOT part of this
          // reply. Re-enqueue under a distinct drain jobId so it is not
          // stranded unanswered. result.latestInboundAt is exactly what this
          // run loaded, so an unchanged watermark never triggers a spurious
          // re-drive; a null watermark means we skipped/escalated (bot paused).
          if (result.latestInboundAt) {
            const liveLatest = await messagesRepo.latestInboundAt(deps.db, job.data.conversationId);
            if (liveLatest && liveLatest.getTime() > result.latestInboundAt.getTime()) {
              logger.info(
                { conversationId: job.data.conversationId },
                'inbound arrived during processing; re-enqueuing drain job',
              );
              await enqueueDrain(deps.respondQueue, job.data.conversationId, job.data.salonId);
            }
          }
        } catch (err) {
          logger.error(
            { err, conversationId: job.data.conversationId },
            'generateResponse threw unexpectedly; dropping this turn to keep the conversation alive',
          );
        }
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
