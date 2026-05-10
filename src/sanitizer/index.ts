import { SanitizerEmptyOutputError } from '../lib/errors.js';

export interface SanitizeContext {
  bookingLink: string;
  bookingLinkSentInLastN: (n: number) => Promise<boolean>;
  policy: {
    maxWordsPerMessage: number;
    maxEmojis: number;
    bookingLinkDedupWindow: number;
  };
}

export interface SanitizeResult {
  messages: string[];
  modifications: string[];
}

export async function sanitize(raw: string, ctx: SanitizeContext): Promise<SanitizeResult> {
  const mods: string[] = [];
  let text = raw.trim();

  const beforeScrub = text;
  text = text
    .replace(/[—–]/g, '-')
    .replace(/[…]/g, '')
    .replace(/;/g, ',')
    .replace(/\s+/g, ' ')
    .trim();
  if (text !== beforeScrub) mods.push('forbidden_chars_scrubbed');

  const linkRe = /https?:\/\/\S+/g;
  const links = [...text.matchAll(linkRe)].map((m) => m[0]);
  if (links.length > 1) {
    const keep = links.find((l) => l.includes(ctx.bookingLink)) ?? links[0];
    for (const link of links) {
      if (link !== keep) text = text.replace(link, '');
    }
    text = text.replace(/\s+/g, ' ').trim();
    mods.push('extra_links_stripped');
  }

  if (text.includes(ctx.bookingLink)) {
    if (await ctx.bookingLinkSentInLastN(ctx.policy.bookingLinkDedupWindow)) {
      text = text.replace(ctx.bookingLink, '').replace(/\s+/g, ' ').trim();
      mods.push('booking_link_deduplicated');
    }
  }

  const emojiRe = /\p{Extended_Pictographic}/gu;
  const emojiMatches = [...text.matchAll(emojiRe)];
  if (emojiMatches.length > ctx.policy.maxEmojis) {
    let kept = 0;
    text = text.replace(emojiRe, (m) => (kept++ < ctx.policy.maxEmojis ? m : ''));
    text = text.replace(/\s+/g, ' ').trim();
    mods.push('emojis_capped');
  }

  if (text.length === 0) {
    throw new SanitizerEmptyOutputError(raw, mods);
  }

  return { messages: [text], modifications: mods };
}
