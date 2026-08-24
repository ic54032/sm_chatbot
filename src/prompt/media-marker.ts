/**
 * Plain-text markers for inbound media the model cannot see.
 *
 * Why this exists: a media-only message (video, voice note, shared reel,
 * view-once photo) is persisted with `text_content = NULL`. Rendering it into
 * the prompt as an empty string produces `{ role: 'user', content: '' }`, which
 * the OpenAI and Anthropic APIs both REJECT — and because the row stays in the
 * loaded history window, every later call on that conversation fails the same
 * way until it scrolls out. A marker keeps the turn present and valid, so the
 * bot answers like a receptionist who was handed something rather than one who
 * saw a blank message.
 *
 * Marker wording is machinery-free (Section 12 of the master prompt): it never
 * mentions our system. As of 2026-08-24 it does not mention the medium either.
 * See the constants below for why.
 */
/**
 * Two markers, not four, and neither names a medium.
 *
 * A controlled comparison inside one production session (2026-08-23) showed the
 * marker is what triggers the bot admitting a limitation. Same build, same
 * prompt: a reel pasted as a link carries no marker and came out clean twice
 * ("ooh, what do you love about that one?"), while `[client sent a video]` and
 * `[client sent a voice note]` both disclosed, the video as "can't view videos
 * directly". Naming a medium the model knows it cannot consume invites it to be
 * honest about that, which is a good instinct pointed at the wrong subject. Two
 * prompt rules forbidding the disclosure in plain words did not hold.
 *
 * So the marker states what is missing from the message and what to do about it,
 * and nothing about us. Video, voice note and unviewable media all lead to the
 * same move, which is why three markers became one.
 *
 * The comma is deliberate: a dash here would seed the model's context with
 * punctuation the prompt bans from replies.
 */
export const MARKER_NO_TEXT = '[no text in this message, ask what they are after]';
export const MARKER_NO_IMAGE = '[no image in this message, invite them to send it again]';

interface RawAttachment {
  type?: unknown;
}

function readAttachments(rawContent: unknown): RawAttachment[] {
  if (!rawContent || typeof rawContent !== 'object') return [];
  const atts = (rawContent as { attachments?: unknown }).attachments;
  return Array.isArray(atts) ? (atts.filter((a) => a && typeof a === 'object') as RawAttachment[]) : [];
}

/**
 * The marker describing what a media message carried, or null when the message
 * has nothing media-ish about it (a plain text turn).
 *
 * Priority follows how the message was handled upstream: video and audio are
 * hard-escalated by handle-inbound, an image that reached us but could not be
 * shown is the B3 resend case, and "no parseable attachment on a non-text
 * message" is the shared-reel / view-once case GHL drops at ingestion.
 */
export function mediaMarkerFor(message: { channelType: string; rawContent: unknown }): string | null {
  const types = readAttachments(message.rawContent).map((a) => a.type);
  if (types.includes('video') || types.includes('audio')) return MARKER_NO_TEXT;
  if (types.includes('image')) return MARKER_NO_IMAGE;
  if (message.channelType !== 'text' && message.channelType !== 'system') return MARKER_NO_TEXT;
  return null;
}
