import type { Salon, ConversationContext } from '../core/types.js';
import type { ContentBlock } from '../llm/client.js';
import type { ProcessedImage } from '../images/process.js';
import { loadMasterPrompt } from './load-master-prompt.js';
import { mediaMarkerFor, MARKER_PHOTO_FAILED } from './media-marker.js';

export interface BuildPromptInput {
  salon: Salon;
  ctx: ConversationContext;
  bookingLinkRecentlySent: boolean;
  imagesByMessageId: Map<string, ProcessedImage[]>;
  /** Inbound messages whose image could not be fetched/processed — marked so the
   * model asks for a resend instead of the backend silently escalating. */
  unviewableImageMessageIds?: Set<string>;
}

export interface BuildPromptOutput {
  systemPrompt: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string | ContentBlock[] }>;
}

/**
 * Hours between the start of the current client message burst (the trailing
 * run of consecutive inbounds) and whatever message came before it. This is
 * the gap the prompt's "fresh exchange after ~12h" rule cares about. Computed
 * from the burst START so rapid multi-message batches after a long silence
 * still report the long gap, not the seconds between batched messages.
 * Returns null when there is no message before the burst (new conversation).
 */
export function hoursSinceLastClientMessage(messages: ConversationContext['recentMessages'], now: Date = new Date()): number | null {
  let i = messages.length - 1;
  while (i >= 0 && messages[i].direction === 'inbound') i--;
  if (i < 0) return null; // conversation is all inbound so far — nothing to measure against
  const burstStart = messages[i + 1]?.createdAt ?? now;
  const gapMs = burstStart.getTime() - messages[i].createdAt.getTime();
  return Math.max(0, Math.round(gapMs / 3_600_000));
}

export function buildPrompt(input: BuildPromptInput): BuildPromptOutput {
  const { salon, ctx, bookingLinkRecentlySent, imagesByMessageId, unviewableImageMessageIds } = input;
  const sot = salon.sourceOfTruth;
  const bookingUrl = sot.booking.url;
  const state = ctx.conversation.state;
  const inboundCount = ctx.recentMessages.filter((m) => m.direction === 'inbound').length;

  const bookingHeader = `# BOOKING URL (PASTE VERBATIM)
The booking URL is: ${bookingUrl}
Paste it exactly, character for character, whenever you share it. Never paraphrase, shorten, or describe it.`;

  // How many images the model can actually see on THIS turn: the pixels attached
  // to whatever the client has sent since our last reply.
  //
  // This is stated as a FACT rather than left for the model to infer, because
  // inferring it has failed repeatedly. With no image in context at all the bot
  // still praised "the vibe of that reel" and "that blend in the reel"
  // (production 2026-08-17), reaching back to a link or a two-day-old photo in the
  // history. Four prompt rules forbidding that did not hold — a 52KB prompt has
  // too much competing for attention — but the model demonstrably does read and
  // obey this state block, which is how the booking-link dedup works.
  let visiblePhotos = 0;
  for (let i = ctx.recentMessages.length - 1; i >= 0; i--) {
    const m = ctx.recentMessages[i];
    if (m.direction !== 'inbound') break; // stop at our own last reply
    visiblePhotos += imagesByMessageId.get(m.id)?.length ?? 0;
  }

  const stateLines = [
    `- Booking link sent recently (within last ${salon.config.booking_link_dedup_window_hours}h): ${bookingLinkRecentlySent}`,
    `- Total inbound messages this conversation: ${inboundCount}`,
    `- Photos visible to you this turn: ${visiblePhotos}`,
    `- State flags JSON: ${JSON.stringify(state)}`,
  ];

  // Time awareness (master prompt Section 2): both lines are optional by
  // contract — the prompt falls back to safe behavior when they are absent.
  if (salon.config.timezone) {
    try {
      const nowLocal = new Intl.DateTimeFormat('en-US', {
        timeZone: salon.config.timezone,
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      }).format(new Date());
      stateLines.push(`- Current date and time (salon local): ${nowLocal}`);
    } catch {
      // Invalid IANA name in config — omit the line (prompt handles absence)
      // rather than killing the whole response.
    }
  }
  const gapHours = hoursSinceLastClientMessage(ctx.recentMessages);
  if (gapHours !== null) {
    stateLines.push(`- Hours since last client message: ${gapHours}`);
  }

  const conversationState = `# Conversation state\n${stateLines.join('\n')}`;

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
      } else if (unviewableImageMessageIds?.has(m.id)) {
        // Image was sent but could not be opened. The "[photo not received]"
        // marker routes the model to its attachment-not-visible behavior (ask
        // for a resend warmly, no technical excuse). Any caption is kept.
        const caption = m.textContent ? `${m.textContent} ` : '';
        messages.push({ role: 'user', content: `${caption}${MARKER_PHOTO_FAILED}` });
      } else {
        // A media-only message (video, voice note, shared reel, view-once) has
        // no text. Emitting "" here would produce an API-invalid empty content
        // block and, since the row stays in the loaded window, would fail EVERY
        // later call on this conversation. Describe what arrived instead.
        // The marker is added even when a caption is present, so "can you do
        // this?" sent with a video does not read as a standalone question.
        const content = [m.textContent, mediaMarkerFor(m)].filter(Boolean).join(' ');
        if (content) messages.push({ role: 'user', content });
      }
    } else if (m.direction === 'outbound' || m.direction === 'owner') {
      // Same invariant on the assistant side: never emit an empty turn.
      const content = m.textContent ?? '';
      if (content) messages.push({ role: 'assistant', content });
    }
  }

  return { systemPrompt, messages };
}
