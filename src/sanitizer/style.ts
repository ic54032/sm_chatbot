/**
 * Deterministic enforcement of the two style rules that keep losing.
 *
 * Sentence-initial capitals and banned openers have been written into the master
 * prompt three rounds running and have failed all three ("Could you let me
 * know", "The best way", "absolutely!", "thanks for reaching out"). Prose in a
 * 46 KB prompt competing with a large JSON knowledge base and inline images is
 * not a reliable enforcement mechanism; a pure function is.
 *
 * Both passes are deliberately conservative. They only touch the FIRST word of a
 * sentence, they never lowercase a word the salon's own vocabulary says is a
 * name, and they leave "I" alone. Anything they are unsure about, they leave.
 */

/**
 * Openers banned by the prompt that kept coming back anyway.
 *
 * The lookahead is load-bearing. These words are also ordinary adjectives, so
 * matching on a word boundary alone amputated the subject of real sentences:
 * "Perfect for fine hair, this gloss is $65" shipped as "for fine hair...".
 * A banned opener is a standalone interjection — it must be followed by
 * terminal punctuation or nothing at all.
 */
const BANNED_OPENERS =
  /^(absolutely|certainly|of course|indeed|perfect|amazing|wonderful|fantastic|great|sure thing|thanks for reaching out|hi there|hey there|hello there)(?=\s*[,!.]|\s*$)[,!.\s]*/i;

/** Words that legitimately keep their capital at the start of a sentence. */
const ALWAYS_CAPITAL = new Set(['i']);

export interface StyleContext {
  /** Proper nouns from the salon's knowledge base — stylist names, the salon
   * name, brands. These keep their capital wherever they appear. */
  properNouns: string[];
}

/** Every capitalised token that must survive, lowercased for comparison. */
function protectedWords(ctx: StyleContext): Set<string> {
  const out = new Set(ALWAYS_CAPITAL);
  for (const phrase of ctx.properNouns) {
    for (const word of String(phrase).split(/[^\p{L}\p{N}']+/u)) {
      if (word.length > 1) out.add(word.toLowerCase());
    }
  }
  return out;
}

/**
 * Lowercase the first word of each sentence, unless it is a proper noun, "I",
 * an acronym, or something that is not a plain word (a URL, a price, an emoji).
 */
export function enforceLowercaseSentences(text: string, ctx: StyleContext): string {
  const protectedSet = protectedWords(ctx);

  return text.replace(/(^|[.!?]\s+|\n)(\p{Lu}[\p{L}']*)/gu, (match, lead: string, word: string) => {
    // ALL-CAPS or CamelCase tokens are acronyms or brand spellings — leave them.
    if (word.length > 1 && word.slice(1) !== word.slice(1).toLowerCase()) return match;
    if (protectedSet.has(word.toLowerCase())) return match;
    return `${lead}${word.charAt(0).toLowerCase()}${word.slice(1)}`;
  });
}

/** Remove a banned filler opener, keeping the sentence that follows it. */
export function stripBannedOpener(text: string): string {
  const stripped = text.replace(BANNED_OPENERS, '');
  if (stripped === text) return text;
  // Removing "Absolutely! " leaves the next word capitalised mid-style; the
  // lowercase pass runs after this and will settle it.
  return stripped.trimStart();
}

/**
 * Apply both passes. Returns the text and whether anything changed, so the
 * caller can record it in sanitize_mods and we can see how often the prompt is
 * losing without reading transcripts.
 */
export function applyStyleRules(text: string, ctx: StyleContext): { text: string; changed: boolean } {
  const afterOpener = stripBannedOpener(text);

  // A style pass must never be able to empty a reply. "Perfect!" is exactly the
  // one-word acknowledgement this rule targets, and stripping it to nothing
  // would raise SanitizerEmptyOutputError — costing an extra LLM call and, if
  // that also came back thin, a canned line plus a 12-hour pause on a turn the
  // model had actually answered. When nothing of substance survives, keep the
  // original and let the prompt own it.
  const hasSubstance = /\p{L}|\p{N}/u.test(afterOpener);
  const base = hasSubstance ? afterOpener : text;

  const afterCase = enforceLowercaseSentences(base, ctx);
  return { text: afterCase, changed: afterCase !== text };
}
