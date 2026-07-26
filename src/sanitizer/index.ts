import { SanitizerEmptyOutputError } from '../lib/errors.js';
import { splitOnSentenceBoundaries } from './split.js';

export interface SanitizeContext {
  bookingLink: string;
  policy: {
    maxWordsPerMessage: number;
    maxEmojis: number;
  };
}

export interface SanitizeResult {
  messages: string[];
  modifications: string[];
}

export async function sanitize(raw: string, ctx: SanitizeContext): Promise<SanitizeResult> {
  const mods: string[] = [];
  let text = raw.trim();

  // 1. Extract URLs first (protect them from forbidden-char scrub).
  const linkRe = /https?:\/\/\S+/g;
  const rawLinks = [...text.matchAll(linkRe)].map((m) => m[0]);
  const trimTrailingPunct = (url: string): string => url.replace(/[.,;:!?)\]}]+$/, '');
  const links = rawLinks.map(trimTrailingPunct);

  // 2. Mask URLs with placeholders so the char scrub does not mutate them.
  //    Placeholder uses only ASCII letters/digits — not affected by char scrub
  //    or whitespace collapse. Prefixed with \x00 to avoid colliding with prose.
  const placeholder = (i: number): string => `\x00URL${i}\x00`;
  for (let i = 0; i < rawLinks.length; i++) {
    text = text.replace(rawLinks[i], placeholder(i));
  }

  // 3. Forbidden char scrub.
  const beforeScrub = text;
  text = text
    // An em/en dash used to become a bare hyphen, which glued the words either
    // side together: "live availability—just grab a spot" read as
    // "availability-just" (QA Round 2, item 4.7). A comma preserves the pause
    // and the spacing. Surrounding whitespace is absorbed so we never emit " , ".
    .replace(/\s*[—–]\s*/g, ', ')
    .replace(/[…]/g, '')
    .replace(/;/g, ',')
    .replace(/\s+/g, ' ')
    .trim();
  if (text !== beforeScrub) mods.push('forbidden_chars_scrubbed');

  // 4. Restore URLs (clean versions).
  for (let i = 0; i < links.length; i++) {
    text = text.replace(placeholder(i), links[i]);
  }

  // 5. Link cap (exact URL equality for booking link).
  if (links.length > 1) {
    const keep = links.find((l) => l === ctx.bookingLink) ?? links[0];
    for (const link of links) {
      if (link !== keep) text = text.replace(link, '');
    }
    text = text.replace(/\s+/g, ' ').trim();
    mods.push('extra_links_stripped');
  }

  // NOTE: there is deliberately no across-turn booking-link dedup here. It used
  // to strip the URL whenever the link had been sent within the dedup window,
  // but that stripped the link even when the model legitimately re-pasted it
  // (client says "i do not see it", explicit re-request), producing broken
  // replies like "here it is again for you: Happy booking!" with no URL
  // (production 2026-07-11). Whether to re-paste vs refer conversationally is a
  // conversational judgment that belongs in the prompt (the "# Conversation
  // state" block tells the model the link was sent recently); the sanitizer no
  // longer overrides that decision. Removing it also retires the old
  // dangling-colon bug, since the URL now stays put instead of being scrubbed.

  // 6. Emoji cap (codepoint-level; ZWJ orphan known issue, see fixture 03).
  const emojiRe = /\p{Extended_Pictographic}/gu;
  const emojiMatches = [...text.matchAll(emojiRe)];
  if (emojiMatches.length > ctx.policy.maxEmojis) {
    let kept = 0;
    text = text.replace(emojiRe, (m) => (kept++ < ctx.policy.maxEmojis ? m : ''));
    text = text.replace(/\s+/g, ' ').trim();
    mods.push('emojis_capped');
  }

  // 8. Word-count split.
  const words = text.split(/\s+/).filter(Boolean);
  let messages: string[];
  if (words.length <= ctx.policy.maxWordsPerMessage) {
    messages = [text];
  } else {
    messages = splitOnSentenceBoundaries(text, ctx.policy.maxWordsPerMessage, 2);
    mods.push('split_into_multiple');
  }

  // 9. Empty check.
  messages = messages.map((m) => m.trim()).filter(Boolean);
  if (messages.length === 0) {
    throw new SanitizerEmptyOutputError(raw, mods);
  }

  return { messages, modifications: mods };
}
