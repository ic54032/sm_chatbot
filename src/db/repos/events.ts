import type { Db } from '../kysely.js';

export async function insert(db: Db, conversationId: string, eventType: string, payload: Record<string, unknown> = {}): Promise<void> {
  await db
    .insertInto('conversation_events')
    .values({
      conversation_id: conversationId,
      event_type: eventType,
      payload: JSON.stringify(payload),
    })
    .execute();
}

export async function recentBookingLinkSent(db: Db, conversationId: string, withinLastN: number): Promise<boolean> {
  const cutoffRow = await db
    .selectFrom('messages')
    .where('conversation_id', '=', conversationId)
    .where('direction', '=', 'outbound')
    .orderBy('created_at', 'desc')
    .offset(withinLastN - 1)
    .limit(1)
    .select('created_at')
    .executeTakeFirst();

  const cutoff = cutoffRow?.created_at ?? new Date(0);

  const found = await db
    .selectFrom('conversation_events')
    .where('conversation_id', '=', conversationId)
    .where('event_type', '=', 'booking_link_sent')
    .where('created_at', '>=', cutoff)
    .limit(1)
    .select('id')
    .executeTakeFirst();

  return !!found;
}
