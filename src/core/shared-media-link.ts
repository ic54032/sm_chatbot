/**
 * Detects a pasted link to a post, reel, or video the bot cannot open.
 *
 * A client who shares a reel is often the highest-intent DM a salon gets ("can
 * you do this look?"). When Instagram delivers that as a NATIVE share the webhook
 * arrives with attachments_raw set and no text, and `unviewable_media` already
 * catches it. But when the client pastes or forwards the link as text, the
 * webhook is an ordinary text message: attachments_raw is [], attachmentCount is
 * 0, and nothing fired. Verified in production 2026-08-23 — the owner was never
 * told, while the bot replied "i can't view the reel directly" on its own.
 *
 * This matches URL STRUCTURE, not meaning: a known host plus a known path
 * segment. There is no attempt to infer what the client wants from their wording,
 * which is the part that belongs to the model. A bare profile link
 * (instagram.com/lumenhairstudio) is not a shared post and does not match.
 */
const SHARED_POST_URL =
  /\bhttps?:\/\/(?:[a-z0-9-]+\.)*instagram\.com\/(?:reel|reels|p|tv|share)\/[A-Za-z0-9_-]/i;

/** True when the text contains a link to Instagram content the bot cannot see. */
export function containsSharedMediaLink(text: string | null | undefined): boolean {
  if (!text) return false;
  return SHARED_POST_URL.test(text);
}
