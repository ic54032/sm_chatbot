/**
 * Plain-text markers for inbound media the model cannot see.
 *
 * Why this exists: a media-only message (video, voice note, shared reel,
 * view-once photo) is persisted with `text_content = NULL`. Rendering it into
 * the prompt as an empty string produces `{ role: 'user', content: '' }`, which
 * the OpenAI and Anthropic APIs both REJECT — and because the row stays in the
 * loaded history window, every later call on that conversation fails the same
 * way until it scrolls out. A marker keeps the turn present and valid, and tells
 * the model what actually arrived so it can respond like a receptionist who
 * heard "I sent you something" rather than one who saw a blank message.
 *
 * Marker wording is deliberately neutral and machinery-free (Section 12 of the
 * master prompt): it states what the client did, never what our system did.
 */
export const MARKER_VIDEO = '[client sent a video]';
export const MARKER_VOICE = '[client sent a voice note]';
export const MARKER_PHOTO_FAILED = '[photo not received]';
export const MARKER_UNVIEWABLE = '[client sent an attachment that did not come through]';

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
  if (types.includes('video')) return MARKER_VIDEO;
  if (types.includes('audio')) return MARKER_VOICE;
  if (types.includes('image')) return MARKER_PHOTO_FAILED;
  if (message.channelType !== 'text' && message.channelType !== 'system') return MARKER_UNVIEWABLE;
  return null;
}
