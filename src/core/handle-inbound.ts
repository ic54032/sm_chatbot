import type { Queue } from 'bullmq';
import type { Db } from '../db/kysely.js';
import type { GhlFactory } from '../ghl/client.js';
import type { LlmClient } from '../llm/client.js';
import * as salonsRepo from '../db/repos/salons.js';
import * as conversationsRepo from '../db/repos/conversations.js';
import * as messagesRepo from '../db/repos/messages.js';
import type { RespondJobData } from '../queue/index.js';
import { logger } from '../lib/logger.js';

export interface HandleInboundInput {
  locationId: string;
  contactId: string;
  contactHandle: string | null;
  messageId: string | null;
  messageText: string | null;
  rawPayload: unknown;
}

export interface HandleInboundDeps {
  db: Db;
  ghlFor: GhlFactory;
  llm: LlmClient;
  defaultLlmModel: string;
  respondQueue: Queue<RespondJobData>;
  responseDelayMsOverride?: number;
}

export async function handleInbound(deps: HandleInboundDeps, input: HandleInboundInput): Promise<void> {
  const salon = await salonsRepo.findByLocationId(deps.db, input.locationId);
  if (!salon) {
    logger.info({ locationId: input.locationId }, 'salon not found for inbound; dropping');
    return;
  }

  const ghl = deps.ghlFor(salon);

  let textContent = input.messageText ?? '';
  if (!textContent && input.messageId) {
    const fetched = await ghl.getMessage(input.messageId);
    textContent = fetched.text;
  }
  if (!textContent) {
    logger.warn({ locationId: input.locationId, contactId: input.contactId }, 'inbound has no text; dropping');
    return;
  }

  const conversation = await conversationsRepo.findOrCreate(deps.db, salon.id, input.contactId, input.contactHandle);

  const inserted = await messagesRepo.insertInbound(deps.db, {
    conversationId: conversation.id,
    channelType: 'text',
    rawContent: input.rawPayload,
    textContent,
    ghlMessageId: input.messageId,
  });
  if (!inserted) {
    logger.debug({ messageId: input.messageId }, 'idempotent duplicate; skipping');
    return;
  }

  await conversationsRepo.touchLastMessageAt(deps.db, conversation.id, new Date());

  if (conversation.handoffUntil && conversation.handoffUntil > new Date()) {
    logger.info({ conversationId: conversation.id }, 'handoff active; bot paused');
    return;
  }

  // Rolling-delay coalescing: remove pending job (if any) and schedule fresh.
  // BullMQ semantics: queue.add with same jobId on a delayed/waiting job is a no-op
  // and keeps the existing timer. To reset the timer when a new inbound arrives,
  // we explicitly remove the previous job before adding.
  // jobId separator is `-` not `:` — BullMQ v5 reserves `:` for Redis key namespacing.
  const jobId = `respond-${conversation.id}`;
  const delay = deps.responseDelayMsOverride ?? salon.config.response_delay_ms;

  await deps.respondQueue.remove(jobId).catch(() => undefined);
  await deps.respondQueue.add(
    'respond',
    { conversationId: conversation.id, salonId: salon.id },
    { jobId, delay, removeOnComplete: true, removeOnFail: 10 },
  );
}
