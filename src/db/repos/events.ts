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

export async function recentBookingLinkSent(db: Db, conversationId: string, withinHours: number): Promise<boolean> {
  // Time-based dedup: was a booking_link_sent event recorded for this
  // conversation within the last `withinHours` hours? Previously this was
  // based on a count of outbound messages; switched to wall-clock time so
  // a multi-day conversation re-paste the link after a 24h+ gap.
  const cutoff = new Date(Date.now() - withinHours * 3600 * 1000);

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

/**
 * Was this conversation already escalated for `reason` within the last
 * `withinMinutes`? Used to stop an alert storm: a broken model account fails
 * every inbound identically, and without this the owner gets one red
 * notification per client message (production 2026-07-22: nine in a day).
 */
export async function recentEscalationWithReason(
  db: Db,
  conversationId: string,
  reason: string,
  withinMinutes: number,
): Promise<boolean> {
  const cutoff = new Date(Date.now() - withinMinutes * 60 * 1000);
  const rows = await db
    .selectFrom('conversation_events')
    .where('conversation_id', '=', conversationId)
    .where('event_type', '=', 'escalated_to_owner')
    .where('created_at', '>=', cutoff)
    .select('payload')
    .execute();

  // The reason lives inside the JSON payload. Filtering here rather than in SQL
  // keeps this dialect-agnostic, and the window only ever holds a few rows.
  return rows.some((row) => {
    const payload = typeof row.payload === 'string' ? safeParse(row.payload) : row.payload;
    return (payload as { reason?: unknown } | null)?.reason === reason;
  });
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/** created_at of the newest inbound message a prior reply actually addressed,
 * recorded via a 'replied' event's answeredInboundAt payload. The answered-guard
 * compares the newest loaded inbound against this to decide whether there is
 * genuinely something new to answer (B6). Returns null if no reply yet. */
export async function latestRepliedInboundAt(db: Db, conversationId: string): Promise<Date | null> {
  const row = await db
    .selectFrom('conversation_events')
    .where('conversation_id', '=', conversationId)
    .where('event_type', '=', 'replied')
    .orderBy('created_at', 'desc')
    .limit(1)
    .select('payload')
    .executeTakeFirst();
  if (!row) return null;
  const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
  const at = (payload as { answeredInboundAt?: string } | null)?.answeredInboundAt;
  return at ? new Date(at) : null;
}
