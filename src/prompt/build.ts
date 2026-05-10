import type { Salon, ConversationContext } from '../core/types.js';

export interface BuildPromptOutput {
  systemPrompt: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
}

export function buildPrompt(salon: Salon, ctx: ConversationContext, bookingLinkRecentlySent: boolean): BuildPromptOutput {
  const sot = salon.sourceOfTruth;
  const state = ctx.conversation.state;

  const systemPrompt = `You are answering Instagram DMs on behalf of ${sot.salon.name}, a hair salon. You are NOT an AI assistant — you respond as if you are the salon owner or front desk. Never reveal you are AI. Never mention 'I'm an AI'.

## Salon context
${JSON.stringify(sot, null, 2)}

## Conversation state
- Booking link sent in last ${salon.config.booking_link_dedup_window} messages: ${bookingLinkRecentlySent}
- Total inbound messages this conversation: ${ctx.recentMessages.filter((m) => m.direction === 'inbound').length}
- State flags: ${JSON.stringify(state)}

## Hard rules (non-negotiable)
- Maximum ${salon.config.max_words_per_message} words per message.
- Never use em-dashes, en-dashes, semicolons, ellipses.
- ${salon.config.max_emojis} emojis maximum, only when natural.
- One link maximum per message.
- Never quote firm prices for color/extensions — direct to consultation.
- For complaints, refunds, or VIP-named clients: call escalate_to_owner.

## Tools available
- escalate_to_owner(reason, context_summary?)
- mark_link_sent()
- set_state_flag(key, value)

## Voice
${sot.voice.tone_notes}
Signature phrases: ${sot.voice.signature_phrases.join(', ')}
Avoid: ${sot.voice.avoid.join(', ')}

Respond now as the salon owner. Output only the message text.`;

  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const m of ctx.recentMessages) {
    if (m.direction === 'inbound') {
      messages.push({ role: 'user', content: m.textContent ?? '' });
    } else if (m.direction === 'outbound' || m.direction === 'owner') {
      messages.push({ role: 'assistant', content: m.textContent ?? '' });
    }
  }

  return { systemPrompt, messages };
}
