import type { Db } from '../kysely.js';

export interface InsertInboundInput {
  conversationId: string;
  channelType: 'text' | 'image' | 'voice';
  rawContent: unknown;
  textContent: string | null;
  ghlMessageId: string | null;
}

export async function insertInbound(db: Db, input: InsertInboundInput): Promise<{ id: string } | null> {
  if (input.ghlMessageId) {
    const existing = await db
      .selectFrom('messages')
      .where('ghl_message_id', '=', input.ghlMessageId)
      .select('id')
      .executeTakeFirst();
    if (existing) return null;
  }

  const row = await db
    .insertInto('messages')
    .values({
      conversation_id: input.conversationId,
      direction: 'inbound',
      channel_type: input.channelType,
      raw_content: JSON.stringify(input.rawContent),
      text_content: input.textContent,
      ghl_message_id: input.ghlMessageId,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return { id: row.id };
}

export interface InsertOutboundInput {
  conversationId: string;
  textContent: string;
  aiRawOutput: string | null;
  sanitizeMods: string[];
  promptTokens: number;
  completionTokens: number;
  costUsd: number | null;
  ghlMessageId: string;
}

export async function insertOutbound(db: Db, input: InsertOutboundInput): Promise<{ id: string }> {
  const row = await db
    .insertInto('messages')
    .values({
      conversation_id: input.conversationId,
      direction: 'outbound',
      channel_type: 'text',
      raw_content: JSON.stringify({ text: input.textContent }),
      text_content: input.textContent,
      ai_raw_output: input.aiRawOutput,
      sanitize_mods: JSON.stringify(input.sanitizeMods),
      prompt_tokens: input.promptTokens,
      completion_tokens: input.completionTokens,
      cost_usd: input.costUsd === null ? null : input.costUsd.toFixed(6),
      ghl_message_id: input.ghlMessageId,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return { id: row.id };
}

/** Count inbound messages for a salon in [from, to). Used by the health check. */
export async function countInboundForSalon(db: Db, salonId: string, from: Date, to: Date): Promise<number> {
  const row = await db
    .selectFrom('messages')
    .innerJoin('conversations', 'conversations.id', 'messages.conversation_id')
    .where('conversations.salon_id', '=', salonId)
    .where('messages.direction', '=', 'inbound')
    .where('messages.created_at', '>=', from)
    .where('messages.created_at', '<', to)
    .select((eb) => eb.fn.countAll().as('n'))
    .executeTakeFirst();
  return Number(row?.n ?? 0);
}
