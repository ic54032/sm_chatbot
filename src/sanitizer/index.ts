import { SanitizerEmptyOutputError } from '../lib/errors.js';
import { splitOnSentenceBoundaries } from './split.js';
import { applyStyleRules } from './style.js';

export interface SanitizeContext {
  bookingLink: string;
  /** Proper nouns from the salon knowledge base (salon name, stylists, brands).
   * They keep their capital when the lowercase style pass runs. */
  properNouns?: string[];
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

  // 0. Strip markdown BEFORE anything else touches the text.
  //
  //    Instagram renders no markdown — the Send API takes plain text only — so
  //    `[book now](https://...)` reaches the client as literal syntax on the one
  //    message type that matters most (QA Round 3, item 3.2).
  //
  //    Order is not a preference here, it is the bug. The URL regex below is
  //    greedy to non-whitespace, so on `[book](https://x/book)` it captures the
  //    closing paren into rawLinks, trimTrailingPunct removes it from links, and
  //    the restore step emits `[book](https://x/book` — bracket noise plus a
  //    swallowed paren. Reducing the link to its bare URL first makes the rest of
  //    the pipeline see exactly what the client will.
  const beforeMarkdown = text;
  text = text
    // [label](url) -> url. The URL class stops at whitespace or the closing
    // paren, which is safe for the only links this bot sends (booking pages and
    // the salon site); a URL containing balanced parens is a known regex limit
    // and does not occur here.
    .replace(/\[([^\]]*)\]\((\s*)(https?:\/\/[^\s)]+)\)/g, '$3')
    // [label](not-a-url) -> label. Keeps the words, drops the syntax.
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    // Emphasis and code fences the model sometimes reaches for.
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|\s)\*([^*\n]+)\*(?=\s|$|[.,!?])/g, '$1$2')
    .replace(/`{1,3}([^`]+)`{1,3}/g, '$1')
    // Leading heading or bullet markers at the start of a line.
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}[-*+]\s+/gm, '');
  if (text !== beforeMarkdown) mods.push('markdown_stripped');

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

  // 3b. Style rules the prompt keeps losing (QA Round 3, items 5.3 and 5.4).
  //     Runs while URLs are still masked, so it can never touch a link.
  const styled = applyStyleRules(text, { properNouns: ctx.properNouns ?? [] });
  if (styled.changed) mods.push('style_enforced');
  text = styled.text;

  // 4. URLs stay MASKED from here until after the split. A domain's dots look
  //    exactly like sentence boundaries to the splitter, which then rejoins the
  //    pieces with spaces — that is how "lumenhairstudio.glossgenius.com/book"
  //    reached a client as "lumenhairstudio. glossgenius. com/book", a dead link
  //    (production 2026-07-15). A placeholder has no dots and no spaces, so it
  //    survives both the split and the word count as a single token.

  // 5. Link cap (exact URL equality for booking link), applied to placeholders.
  if (links.length > 1) {
    const keepIndex = Math.max(
      0,
      links.findIndex((l) => l === ctx.bookingLink),
    );
    for (let i = 0; i < links.length; i++) {
      if (i !== keepIndex) text = text.replace(placeholder(i), '');
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

  // 8b. Restore URLs, now that the splitter can no longer break them apart.
  messages = messages.map((m) => {
    let restored = m;
    for (let i = 0; i < links.length; i++) {
      restored = restored.replace(placeholder(i), links[i]);
    }
    return restored;
  });

  // 9. Empty check.
  messages = messages.map((m) => m.trim()).filter(Boolean);
  if (messages.length === 0) {
    throw new SanitizerEmptyOutputError(raw, mods);
  }

  return { messages, modifications: mods };
}
