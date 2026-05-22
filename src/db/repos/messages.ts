import type { Db } from '../kysely.js';

export interface InsertInboundInput {
  conversationId: string;
  channelType: 'text' | 'image' | 'voice';
  rawContent: unknown;
  textContent: string;
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
