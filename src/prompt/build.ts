import type { Salon, ConversationContext } from '../core/types.js';
import type { ContentBlock } from '../llm/client.js';
import type { ProcessedImage } from '../images/process.js';
import { loadMasterPrompt } from './load-master-prompt.js';
import { mediaMarkerFor, MARKER_NO_IMAGE } from './media-marker.js';

export interface BuildPromptInput {
  salon: Salon;
  ctx: ConversationContext;
  bookingLinkRecentlySent: boolean;
  imagesByMessageId: Map<string, ProcessedImage[]>;
  /** Inbound messages whose image could not be fetched/processed — marked so the
   * model asks for a resend instead of the backend silently escalating. */
  unviewableImageMessageIds?: Set<string>;
  /** Newest inbound a previous reply actually answered, from the 'replied' event
   * stream. Everything after it is what this turn owes the client. null means no
   * reply has ever been recorded, so the whole window is unanswered. */
  lastAnsweredInboundAt?: Date | null;
}

export interface BuildPromptOutput {
  systemPrompt: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string | ContentBlock[] }>;
  /** The "# Conversation state" lines, handed back so the caller can log them.
   * Every behaviour question this week turned on a value in this block, and none
   * of them were visible in production logs — the photo-count diagnosis took a
   * day of reconstructing arithmetic that one log line would have answered. */
  stateLines: string[];
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
  const answeredUpTo = input.lastAnsweredInboundAt ?? null;
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
  //
  // The same walk also counts the messages themselves. Three client messages
  // arrived five seconds apart on 2026-08-23 18:24 asking how long balayage
  // takes, whether the salon takes card, and what parking is like. All three
  // reached the model in one request (messageShapes idx 12, 13, 14) and the reply
  // answered the first and the last. Coalescing and the drain were both correct;
  // nothing told the model that a trailing run of client messages is one burst in
  // which every question still needs an answer.
  //
  // "Unanswered" is decided by the 'replied' event stream, NOT by walking back to
  // the nearest outbound. That shortcut was the first version of this and it was
  // wrong in production within a day: on 2026-08-24 16:49 an inbound arrived while
  // the previous turn was mid-flight, our reply row landed AFTER it, so the window
  // ended on an assistant turn and every count came out 0 with a real message
  // waiting. The answered-guard above this function documents the same trap in the
  // same words — a reply is always timestamped after a message it did not answer.
  //
  // The cost of getting it wrong is not a wrong log line. All three of these
  // numbers drive prompt rules, so a 0 here silently disables the burst rule in
  // exactly the fast-typing timing that needs it, and tells the model it has no
  // photo on a turn where the pixels are right there.
  const isUnanswered = (m: ConversationContext['recentMessages'][number]) =>
    m.direction === 'inbound' && (!answeredUpTo || m.createdAt.getTime() > answeredUpTo.getTime());

  let visiblePhotos = 0;
  let waitingMessages = 0;
  let answeredPhotos = 0;
  for (const m of ctx.recentMessages) {
    if (m.direction !== 'inbound') continue;
    const photos = imagesByMessageId.get(m.id)?.length ?? 0;
    if (isUnanswered(m)) {
      waitingMessages += 1;
      visiblePhotos += photos;
    } else {
      // Photos we have already replied to. Without this second number
      // "visible: 0" is ambiguous in a way that matters: a client who never sent
      // anything should be invited to, while a client following up on the photo we
      // described one turn ago must NOT be asked to send it again.
      answeredPhotos += photos;
    }
  }

  const stateLines = [
    `- Booking link sent recently (within last ${salon.config.booking_link_dedup_window_hours}h): ${bookingLinkRecentlySent}`,
    `- Total inbound messages this conversation: ${inboundCount}`,
    `- Client messages waiting for this reply: ${waitingMessages}`,
    `- Photos visible to you this turn: ${visiblePhotos}`,
    `- Photos earlier in this conversation, already answered: ${answeredPhotos}`,
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

      // Today's and tomorrow's hours, read straight out of the knowledge base.
      //
      // On Sunday 2026-08-23 at 11:24 Denver time the bot said "not today, but
      // we'll be open tomorrow from 10am to 7pm". The knowledge base has
      // monday: "closed" and tuesday: "10am to 7pm" — it took Tuesday's hours and
      // attached them to Monday. Every fact it needed was already in front of it;
      // what it got wrong was walking the week. So the walk stops being its job.
      //
      // Two lookups, no parsing of "10am to 7pm" and no arithmetic. "Are you open
      // right now" then reduces to comparing the clock above against one short
      // string, instead of reasoning across seven days.
      const weekday = (d: Date) =>
        new Intl.DateTimeFormat('en-US', { timeZone: salon.config.timezone, weekday: 'long' })
          .format(d)
          .toLowerCase();
      const hours = (sot as { salon_basics?: { operating_hours?: Record<string, unknown> } }).salon_basics
        ?.operating_hours;
      if (hours) {
        const today = weekday(new Date());
        const tomorrow = weekday(new Date(Date.now() + 86_400_000));
        const read = (day: string) => (typeof hours[day] === 'string' ? (hours[day] as string) : 'not listed');
        stateLines.push(`- Today (${today}) hours: ${read(today)}`);
        stateLines.push(`- Tomorrow (${tomorrow}) hours: ${read(tomorrow)}`);
      }
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
        messages.push({ role: 'user', content: `${caption}${MARKER_NO_IMAGE}` });
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

  return { systemPrompt, messages, stateLines };
}
