import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import type { Db } from '../db/kysely.js';
import type { GhlClient } from '../ghl/client.js';
import * as escalationsRepo from '../db/repos/escalations.js';
import * as conversationsRepo from '../db/repos/conversations.js';
import * as eventsRepo from '../db/repos/events.js';
import { logger } from '../lib/logger.js';

const AUTO_RESUME_QUEUE = 'auto-resume';
const AUTO_RESUME_INTERVAL_MS = 5 * 60 * 1000;

export interface AutoResumeSetup {
  queue: Queue;
  worker: Worker;
}

export async function setupAutoResume(deps: {
  db: Db;
  ghl: GhlClient;
  connection: ConnectionOptions;
}): Promise<AutoResumeSetup> {
  const queue = new Queue(AUTO_RESUME_QUEUE, { connection: deps.connection });

  // Idempotent recurring schedule. BullMQ deduplicates repeat jobs by
  // (name, repeat options); calling on each startup leaves a single scheduled job.
  await queue.add(
    'auto-resume-tick',
    {},
    {
      repeat: { every: AUTO_RESUME_INTERVAL_MS },
      removeOnComplete: true,
      removeOnFail: 10,
    },
  );

  const worker = new Worker(
    AUTO_RESUME_QUEUE,
    async () => {
      const now = new Date();
      const items = await escalationsRepo.listActiveTimedOut(deps.db, now);
      if (items.length === 0) {
        logger.debug('auto-resume tick: no expired escalations');
        return;
      }
      logger.info({ count: items.length }, 'auto-resume tick: found expired escalations');
      for (const item of items) {
        try {
          await escalationsRepo.markResumed(deps.db, item.escalationId, 'auto_timeout');
          await conversationsRepo.setHandoffUntil(deps.db, item.conversationId, null);
          await deps.ghl.removeTag(item.contactId, ['escalation_active']);
          await eventsRepo.insert(deps.db, item.conversationId, 'bot_resumed', { by: 'auto_timeout' });
          logger.info({ escalationId: item.escalationId, conversationId: item.conversationId }, 'auto-resumed');
        } catch (err) {
          logger.error({ err, escalationId: item.escalationId }, 'auto-resume failed for escalation');
        }
      }
    },
    { connection: deps.connection, concurrency: 1 },
  );

  return { queue, worker };
}
