import type { Db } from '../db/kysely.js';
import type { GhlClient } from '../ghl/client.js';
import type { Salon, Conversation } from './types.js';
import * as escalationsRepo from '../db/repos/escalations.js';
import * as conversationsRepo from '../db/repos/conversations.js';
import * as eventsRepo from '../db/repos/events.js';
import { logger } from '../lib/logger.js';

export interface EscalateInput {
  db: Db;
  ghl: GhlClient;
  salon: Salon;
  conversation: Conversation;
  reason: string;
  contextSummary?: string;
}

export async function escalateToOwner(input: EscalateInput): Promise<void> {
  const handoffUntil = new Date(Date.now() + input.salon.config.handoff_window_hours * 3600_000);

  await input.db.transaction().execute(async (tx) => {
    await escalationsRepo.upsertActive(tx, input.conversation.id, input.reason, input.contextSummary ?? null);
    await conversationsRepo.setHandoffUntil(tx, input.conversation.id, handoffUntil);
    await eventsRepo.insert(tx, input.conversation.id, 'escalated_to_owner', { reason: input.reason });
  });

  try {
    await input.ghl.addTag(input.conversation.ghlContactId, ['escalation_active']);
  } catch (err) {
    logger.error({ err, conversationId: input.conversation.id }, 'ghl addTag failed during escalate');
  }

  try {
    await input.ghl.updateCustomField({
      contactId: input.conversation.ghlContactId,
      fieldId: input.salon.config.ghl_custom_field_ids.last_escalation_reason,
      value: input.reason,
    });
  } catch (err) {
    logger.error({ err, conversationId: input.conversation.id }, 'ghl updateCustomField failed during escalate');
  }

  logger.info({ conversationId: input.conversation.id, reason: input.reason, handoffUntil }, 'escalated to owner');
}
