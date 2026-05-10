import type { Db } from '../db/kysely.js';
import type { GhlClient } from '../ghl/client.js';
import type { LlmClient } from '../llm/client.js';
import * as salonsRepo from '../db/repos/salons.js';
import * as conversationsRepo from '../db/repos/conversations.js';
import * as messagesRepo from '../db/repos/messages.js';
import { generateResponse } from './generate-response.js';
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
  ghl: GhlClient;
  llm: LlmClient;
}

export async function handleInbound(deps: HandleInboundDeps, input: HandleInboundInput): Promise<void> {
  const salon = await salonsRepo.findByLocationId(deps.db, input.locationId);
  if (!salon) {
    logger.info({ locationId: input.locationId }, 'salon not found for inbound; dropping');
    return;
  }

  let textContent = input.messageText ?? '';
  if (!textContent && input.messageId) {
    const fetched = await deps.ghl.getMessage(input.messageId);
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

  // Korak 4: synchronous direct call. Replaced with BullMQ scheduling in Korak 5.
  await generateResponse(deps, salon, conversation.id);
}
