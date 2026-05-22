import type { Db } from '../db/kysely.js';
import type { GhlClient } from '../ghl/client.js';
import type { Salon, Conversation } from './types.js';
import * as defaultMessagesRepo from '../db/repos/messages.js';

export interface CannedDeps {
  db: Db;
  ghl: GhlClient;
  messagesRepo?: {
    insertOutbound: typeof defaultMessagesRepo.insertOutbound;
  };
}

export async function sendCannedReassurance(
  deps: CannedDeps,
  _salon: Salon,
  conversation: Conversation,
  message: string,
): Promise<void> {
  const sent = await deps.ghl.sendMessage({
    contactId: conversation.ghlContactId,
    type: 'IG',
    message,
  });
  const repo = deps.messagesRepo ?? defaultMessagesRepo;
  await repo.insertOutbound(deps.db, {
    conversationId: conversation.id,
    textContent: message,
    aiRawOutput: '',
    sanitizeMods: ['canned_reassurance'],
    promptTokens: 0,
    completionTokens: 0,
    costUsd: null,
    ghlMessageId: sent.ghlMessageId,
  });
}
