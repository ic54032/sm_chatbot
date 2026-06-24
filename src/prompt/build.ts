import type { Salon, ConversationContext } from '../core/types.js';
import type { ContentBlock } from '../llm/client.js';
import type { ProcessedImage } from '../images/process.js';
import { loadMasterPrompt } from './load-master-prompt.js';

export interface BuildPromptInput {
  salon: Salon;
  ctx: ConversationContext;
  bookingLinkRecentlySent: boolean;
  imagesByMessageId: Map<string, ProcessedImage[]>;
}

export interface BuildPromptOutput {
  systemPrompt: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string | ContentBlock[] }>;
}

export function buildPrompt(input: BuildPromptInput): BuildPromptOutput {
  const { salon, ctx, bookingLinkRecentlySent, imagesByMessageId } = input;
  const sot = salon.sourceOfTruth;
  const bookingUrl = sot.booking.url;
  const state = ctx.conversation.state;
  const inboundCount = ctx.recentMessages.filter((m) => m.direction === 'inbound').length;

  const bookingHeader = `# BOOKING URL (PASTE VERBATIM)
The booking URL is: ${bookingUrl}
Paste it exactly, character for character, whenever you share it. Never paraphrase, shorten, or describe it.`;

  const conversationState = `# Conversation state
- Booking link sent recently (within last ${salon.config.booking_link_dedup_window_hours}h): ${bookingLinkRecentlySent}
- Total inbound messages this conversation: ${inboundCount}
- State flags JSON: ${JSON.stringify(state)}`;

  const knowledgeBase = `# Knowledge base
${JSON.stringify(sot, null, 2)}`;

  const systemPrompt = [bookingHeader, loadMasterPrompt(), conversationState, knowledgeBase].join('\n\n');

  const messages: BuildPromptOutput['messages'] = [];
  for (const m of ctx.recentMessages) {
    if (m.direction === 'inbound') {
      const imgs = imagesByMessageId.get(m.id);
      if (imgs && imgs.length > 0) {
        const blocks: ContentBlock[] = [];
        for (const img of imgs) blocks.push({ type: 'image', mediaType: img.mediaType, base64: img.base64 });
        blocks.push({ type: 'text', text: m.textContent ?? '[image only, no caption]' });
        messages.push({ role: 'user', content: blocks });
      } else {
        messages.push({ role: 'user', content: m.textContent ?? '' });
      }
    } else if (m.direction === 'outbound' || m.direction === 'owner') {
      messages.push({ role: 'assistant', content: m.textContent ?? '' });
    }
  }

  return { systemPrompt, messages };
}
