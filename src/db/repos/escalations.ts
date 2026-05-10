import type { Db } from '../kysely.js';

export async function upsertActive(db: Db, conversationId: string, reason: string, contextSummary: string | null): Promise<void> {
  const existing = await db
    .selectFrom('escalations')
    .where('conversation_id', '=', conversationId)
    .where('resumed_at', 'is', null)
    .select('id')
    .executeTakeFirst();
  if (existing) {
    await db
      .updateTable('escalations')
      .set({ reason, context_summary: contextSummary, ghl_tag_added_at: new Date() })
      .where('id', '=', existing.id)
      .execute();
    return;
  }
  await db
    .insertInto('escalations')
    .values({
      conversation_id: conversationId,
      reason,
      context_summary: contextSummary,
      ghl_tag_added_at: new Date(),
    })
    .execute();
}

export interface ActiveTimedOutEscalation {
  escalationId: string;
  conversationId: string;
  contactId: string;
}

export async function listActiveTimedOut(db: Db, now: Date): Promise<ActiveTimedOutEscalation[]> {
  const rows = await db
    .selectFrom('escalations')
    .innerJoin('conversations', 'conversations.id', 'escalations.conversation_id')
    .where('escalations.resumed_at', 'is', null)
    .where('conversations.handoff_until', '<', now)
    .select([
      'escalations.id as escalationId',
      'conversations.id as conversationId',
      'conversations.ghl_contact_id as contactId',
    ])
    .execute();
  return rows;
}

export async function markResumed(db: Db, escalationId: string, resumedBy: 'auto_timeout' | 'owner_manual'): Promise<void> {
  await db
    .updateTable('escalations')
    .set({ resumed_at: new Date(), resumed_by: resumedBy })
    .where('id', '=', escalationId)
    .where('resumed_at', 'is', null)
    .execute();
}

export async function markResumedByConversation(
  db: Db,
  conversationId: string,
  resumedBy: 'auto_timeout' | 'owner_manual',
): Promise<number> {
  const result = await db
    .updateTable('escalations')
    .set({ resumed_at: new Date(), resumed_by: resumedBy })
    .where('conversation_id', '=', conversationId)
    .where('resumed_at', 'is', null)
    .executeTakeFirst();
  return Number(result.numUpdatedRows ?? 0);
}
