// Detect handoff-promise language in bot replies. Backend safety net for the
// LLM tool-call reliability failure mode where the model writes "let me grab
// [owner]" / "I'll let her know" but forgets to actually call escalate_to_owner.
// The customer was promised — we must follow through.
//
// Patterns are intentionally specific to the salon receptionist persona's
// handoff vocabulary (see master-prompt.md HANDOFF RULES + EXAMPLES). False
// positives are acceptable (force-escalating on routine "she'll jump in if"
// language pings the owner unnecessarily) but false negatives are not (a
// customer told the owner is coming but no escalation = trust break).

// NOTE: the `i` flag is intentionally NOT used. We want the pronoun list
// (her/him/them) to match case-insensitively in practice (the bot writes them
// lowercase mid-sentence), but `[A-Z][a-z]+` for proper names MUST stay
// case-sensitive — otherwise "you" matches as a "name" and we false-positive
// on "I'll let you know." The patterns explicitly handle initial-capital
// variants via [Ll]et / [Ss]he etc.
//
// That generic `[A-Z][a-z]+` stopped being enough once the style rules locked
// the voice to all-lowercase: the model now writes "i'll get renata to handle
// this" with a lowercase name, which matched nothing and shipped a handoff
// promise with NO escalation (production 2026-07-26). The fix is to match the
// salon's ACTUAL owner name, spelled case-insensitively via per-letter classes
// so the surrounding patterns stay case-sensitive.
function caseInsensitiveLiteral(word: string): string {
  return word
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .split('')
    .map((ch) => (/[a-z]/i.test(ch) ? `[${ch.toUpperCase()}${ch.toLowerCase()}]` : ch))
    .join('');
}

/** A capitalised generic name plus the real owner name in any case. */
function nameOnly(ownerFirstName?: string): string {
  const parts = ['[A-Z][a-z]+'];
  if (ownerFirstName && /[a-z]/i.test(ownerFirstName)) {
    parts.push(caseInsensitiveLiteral(ownerFirstName.trim()));
  }
  return `(?:${parts.join('|')})`;
}

/** her|him|them plus everything nameOnly accepts. */
function nameAlternation(ownerFirstName?: string): string {
  return `(?:her|him|them|${nameOnly(ownerFirstName)})`;
}

const HANDOFF_PROMISE_PATTERNS: RegExp[] = [
  // "let me grab [Name]" / "let me get her" / "let me pull in [Name]"
  /\b[Ll]et me (?:grab|get|pull(?: in)?|bring in) (?:her|him|them|[A-Z][a-z]+)\b/,
  // "I'll let her know" / "I will let Renata know"
  /\bI(?:'ll| will) let (?:her|him|them|[A-Z][a-z]+) know\b/,
  // "letting [Name] know"
  /\b[Ll]etting (?:her|him|them|[A-Z][a-z]+) know\b/,
  // "she'll/he'll/they'll jump in" / "reach out" / "get back to you"
  /\b(?:[Ss]he|[Hh]e|[Tt]hey)'ll (?:jump in|reach out|get back to you|be (?:with|right) (?:you|with you))\b/,
  // "[Name] will jump in / reach out / get back to you"
  /\b[A-Z][a-z]+ will (?:jump in|reach out|get back to you|be (?:with|right) (?:you|with you))\b/,
  // "she/he/[Name] will/can address/handle this directly"
  /\b(?:[Ss]he|[Hh]e|[A-Z][a-z]+) (?:can|will) (?:address|handle) (?:this|that) (?:directly|herself|himself)\b/,
  // The "handle/take" family below carries a clause-end guard: the object
  // (this/that/it, optionally "one") must NOT be followed by another lowercase
  // word. Real handoff promises end the clause ("handle this one." / "take
  // this one 🤍" / "take it from here"), while ordinary salon vocabulary
  // continues ("take it slow", "take it down a shade", "take this into
  // account", "let Olaplex handle it between visits") — adversarial review
  // found a dozen such benign phrasings, each of which would otherwise
  // force-escalate and pause the bot for the whole handoff window.
  //
  // "I'm letting Renata handle this one" — the exact 2026-07-06 production
  // miss: reassurance shipped, tool never fired.
  /\b[Ll]et(?:ting)? (?:her|him|them|[A-Z][a-z]+) (?:handle|take) (?:(?:this|that|it)(?: one)?(?!\s+[a-z])|it from here\b)/,
  // "Imma let Renata take this one" (literally the master prompt's hostile-
  // language example reassurance) / "I'll let her handle it"
  /\b(?:Imma|[Ii]'?m gonna|[Ii]'ll|[Ii] will) let (?:her|him|them|[A-Z][a-z]+) (?:take|handle) (?:(?:this|that|it)(?: one)?(?!\s+[a-z])|it from here\b)/,
  // "she'll take it from here" / "Renata will take this one 🤍". The name
  // variant excludes sentence-initial determiners/pronouns ("That will take it
  // right out") that [A-Z][a-z]+ would otherwise read as an owner name.
  /\b(?:[Ss]he|[Hh]e|[Tt]hey)'ll take (?:(?:this|that|it)(?: one)?(?!\s+[a-z])|it from here\b)/,
  /\b(?!(?:This|That|It|The|She|He|We|You|They|And|But|So|Yes)\s)[A-Z][a-z]+ will take (?:(?:this|that|it)(?: one)?(?!\s+[a-z])|it from here\b)/,
];

/**
 * Patterns that need the owner's name. Built per salon and cached, because the
 * name is the only reliable token once the reply voice is all-lowercase.
 */
const ownerPatternCache = new Map<string, RegExp[]>();

function ownerAwarePatterns(ownerFirstName?: string): RegExp[] {
  const key = ownerFirstName ?? '';
  const cached = ownerPatternCache.get(key);
  if (cached) return cached;

  const NAME = nameAlternation(ownerFirstName);
  // The reply voice is all-lowercase, so "I" is written "i", and the apostrophe
  // may be straight or typographic. Both cost nothing to accept.
  const AP = `['’]`;
  const I_WILL = `(?:[Ii](?:${AP}ll| will)|Imma|[Ii]${AP}?m gonna|[Ll]et me)`;
  const built = [
    // "i'll get renata to handle this" / "let me have her take a look" /
    // "i'm gonna ask renata to jump on this" — the routing family that says
    // WHO will act, without the word "let ... handle". The 2026-07-26 miss.
    new RegExp(`\\b${I_WILL} (?:get|ask|have|grab|pull in|bring in) ${NAME}\\b`),
    // "renata will get back to you" / "renata's going to take a look" with a
    // lowercase name, which the capitalised variant above cannot see.
    new RegExp(
      `\\b${NAME}(?:${AP}s| is| will| can)? (?:going to |gonna )?(?:jump in|reach out|get back to you|take a look|handle this|take this)\\b`,
    ),
    // "that's one for renata" — handing the topic over by naming its owner.
    // Deliberately NOT accepting a pronoun here: "this is for her" is ordinary
    // product talk ("this mask is for her hair type") and a false positive costs
    // a needless escalation plus a 4h pause.
    new RegExp(`\\b(?:one|this|that)(?:${AP}s| is)? (?:one )?for ${nameOnly(ownerFirstName)}\\b`),
  ];
  ownerPatternCache.set(key, built);
  return built;
}

/**
 * True when the reply promises the client that a human is stepping in. The
 * caller passes the salon's owner first name so a lowercase mention still
 * counts — without it, only the pronoun and capitalised-name patterns apply.
 */
export function containsHandoffPromise(text: string, ownerFirstName?: string): boolean {
  if (HANDOFF_PROMISE_PATTERNS.some((p) => p.test(text))) return true;
  return ownerAwarePatterns(ownerFirstName).some((p) => p.test(text));
}
