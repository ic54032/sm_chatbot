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
  const recent = await db
    .selectFrom('conversation_events')
    .where('conversation_id', '=', conversationId)
    .where('event_type', '=', 'booking_link_sent')
    .orderBy('created_at', 'desc')
    .limit(withinLastN)
    .select('id')
    .execute();
  return recent.length > 0;
}
