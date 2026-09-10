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

/**
 * How many times an escalation for `reason` has been HELD in this conversation.
 *
 * This is the two-strike threshold for client_refused_consultation_path. The
 * first time the model asks to hand over on a consultation objection the
 * escalation is held and one of these events is written; the second time it goes
 * through. QA failed that threshold in Rounds 3, 4 and 5 while it was written as
 * prose in the prompt, because it asks the model to keep a tally across a
 * fifteen-message window while it composes a reply.
 *
 * The count comes from the model's own escalate_to_owner calls rather than from
 * reading the client's words. A first attempt at this counted refusal phrases in
 * the backend with regular expressions, which was the wrong division of labour:
 * the model reads the whole conversation and is the right thing to judge whether
 * a client refused, while the backend is the right thing to count. It also failed
 * closed — any phrasing off the pattern list left the count at zero forever, so
 * the reason became permanently unreachable and a client who genuinely needed a
 * person would never have got one.
 *
 * Deliberately no time window. A held event from days ago lets the next request
 * through immediately, which is early rather than late, and being early only
 * means the owner hears about it one turn sooner than the threshold intended.
 */
export async function heldEscalationCount(db: Db, conversationId: string, reason: string): Promise<number> {
  const rows = await db
    .selectFrom('conversation_events')
    .where('conversation_id', '=', conversationId)
    .where('event_type', '=', 'escalation_held')
    .select('payload')
    .execute();

  // Same shape as recentEscalationWithReason: the reason lives in the JSON
  // payload, and filtering here rather than in SQL keeps this dialect-agnostic.
  return rows.filter((row) => {
    const payload = typeof row.payload === 'string' ? safeParse(row.payload) : row.payload;
    return (payload as { reason?: unknown } | null)?.reason === reason;
  }).length;
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
