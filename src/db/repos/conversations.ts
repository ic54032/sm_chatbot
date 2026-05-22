import { sql } from 'kysely';
import type { Db } from '../kysely.js';
import type { Conversation, ConversationContext, Message, ConversationEvent } from '../../core/types.js';

export async function findOrCreate(
  db: Db,
  salonId: string,
  ghlContactId: string,
  clientHandle: string | null,
): Promise<Conversation> {
  const existing = await db
    .selectFrom('conversations')
    .where('salon_id', '=', salonId)
    .where('ghl_contact_id', '=', ghlContactId)
    .selectAll()
    .executeTakeFirst();
  if (existing) return rowToConversation(existing);

  const inserted = await db
    .insertInto('conversations')
    .values({
      salon_id: salonId,
      ghl_contact_id: ghlContactId,
      client_handle: clientHandle,
      state: '{}',
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return rowToConversation(inserted);
}

export async function setHandoffUntil(db: Db, id: string, until: Date | null): Promise<void> {
  await db.updateTable('conversations').set({ handoff_until: until }).where('id', '=', id).execute();
}

export async function touchLastMessageAt(db: Db, id: string, at: Date): Promise<void> {
  await db.updateTable('conversations').set({ last_message_at: at }).where('id', '=', id).execute();
}

export async function mergeState(db: Db, id: string, patch: Record<string, unknown>): Promise<void> {
  await sql`
    UPDATE conversations
    SET state = state || ${JSON.stringify(patch)}::jsonb
    WHERE id = ${id}
  `.execute(db);
}

export async function loadContext(db: Db, conversationId: string, recentMessageLimit: number): Promise<ConversationContext> {
  const conv = await db
    .selectFrom('conversations')
    .where('id', '=', conversationId)
    .selectAll()
    .executeTakeFirstOrThrow();

  const messages = await db
    .selectFrom('messages')
    .where('conversation_id', '=', conversationId)
    .orderBy('created_at', 'desc')
    .limit(recentMessageLimit)
    .selectAll()
    .execute();

  const events = await db
    .selectFrom('conversation_events')
    .where('conversation_id', '=', conversationId)
    .orderBy('created_at', 'desc')
    .limit(50)
    .selectAll()
    .execute();

  return {
    conversation: rowToConversation(conv),
    recentMessages: messages.reverse().map(rowToMessage),
    recentEvents: events.map(rowToEvent),
  };
}

function rowToConversation(row: {
  id: string;
  salon_id: string;
  ghl_contact_id: string;
  ghl_conversation_id: string | null;
  client_handle: string | null;
  state: unknown;
  handoff_until: Date | null;
  last_message_at: Date | null;
}): Conversation {
  return {
    id: row.id,
    salonId: row.salon_id,
    ghlContactId: row.ghl_contact_id,
    ghlConversationId: row.ghl_conversation_id,
    clientHandle: row.client_handle,
    state: (row.state as Record<string, unknown>) ?? {},
    handoffUntil: row.handoff_until,
    lastMessageAt: row.last_message_at,
  };
}

function rowToMessage(row: {
  id: string;
  conversation_id: string;
  direction: 'inbound' | 'outbound' | 'owner';
  channel_type: 'text' | 'image' | 'voice' | 'system';
  text_content: string | null;
  ai_raw_output: string | null;
  sanitize_mods: unknown;
  ghl_message_id: string | null;
  created_at: Date;
  raw_content: unknown;
}): Message {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    direction: row.direction,
    channelType: row.channel_type,
    textContent: row.text_content,
    aiRawOutput: row.ai_raw_output,
    sanitizeMods: (row.sanitize_mods as string[] | null) ?? null,
    ghlMessageId: row.ghl_message_id,
    createdAt: row.created_at,
    rawContent: row.raw_content,
  };
}

function rowToEvent(row: { id: string; conversation_id: string; event_type: string; payload: unknown; created_at: Date }): ConversationEvent {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    eventType: row.event_type,
    payload: (row.payload as Record<string, unknown>) ?? {},
    createdAt: row.created_at,
  };
}
