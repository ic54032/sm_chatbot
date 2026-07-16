/**
 * 1.9 tripwire — internal-vocabulary / machinery-narration denylist.
 *
 * Defense-in-depth behind Section 12 of the master prompt ("Never narrate your
 * own machinery, in brackets OR in plain English"). `extractLeakedToolCalls`
 * already strips bracketed tool SYNTAX (`[mark_link_sent()]`); this catches the
 * PLAIN-ENGLISH machinery the model sometimes narrates to the client — "I'll
 * note this as the last quoted service", "flagging this for the owner",
 * "putting this in the system" — and bare internal terms (state flag, reason
 * code, escalate). The client must never read the bot's own plumbing
 * (production incident 2026-07-06).
 *
 * Patterns are deliberately TIGHT, and scoped three ways so casual salon speech
 * never trips them:
 *   - FIRST-PERSON or GERUND only for bookkeeping verbs, so third-person /
 *     imperative "we can note that down", "flag her down when you arrive" stay
 *     clean while "I'll note this as..." / "noting your interest" are caught.
 *   - OBJECT-SCOPED (this/that/it/...) so "on the right track", "mark your
 *     calendar", "red flag", "save your spot", "track down that shade" are safe.
 *   - OWNER-SCOPED (a same-clause lookahead for "owner") for the routing verbs
 *     hand-off / escalate, so "hand off your color to a senior stylist" and
 *     "before things escalate" stay clean while owner routing is caught.
 *
 * The negative/positive corpus in internal-vocab.spec.ts is the guardrail for
 * every one of these; add a case there before touching a pattern. Regexes are
 * non-global (stateless `.exec`), so the module can be shared.
 */
export const INTERNAL_VOCAB_PATTERNS: readonly RegExp[] = [
  // Note / record bookkeeping — first-person or gerund only (never 3rd person).
  /\bmake a note\b/i,
  /\b(?:i(?:['’]?ll| will)|let me|lemme) note\b/i,
  /\bnoting (?:this|that|it|you|your)\b/i,
  /\bjot (?:this|that|it|down)\b/i,
  /\bwrite (?:this|that|it) down\b/i,
  /\bfor my records\b/i,
  /\bin my notes\b/i,
  /\b(?:keep|put|have) (?:this|that|it|your \w+) on file\b/i,

  // Internal state identifiers / datastore surfaced verbatim.
  /\blast[-_\s]?quoted[-_\s]?service\b/i,
  /\bstate[-_\s]?flag\b/i,
  /\breason code\b/i,
  /\bcontext[-_\s]?summary\b/i,
  /\b(?:in|into|to) (?:the|our|my) system\b/i,

  // Bare tool / function names (belt-and-suspenders if a non-bracketed form
  // slips past extractLeakedToolCalls).
  /\bset_state_flag\b/i,
  /\bmark_link_sent\b/i,
  /\bescalate_to_owner\b/i,

  // Owner-routing narration — flag / tag / pass-along, plus the owner-scoped
  // hand-off and escalate (so stylist-to-stylist "hand off" and the everyday
  // "before things escalate" stay clean).
  /\bi(?:['’]?ll| will) flag\b/i,
  /\bflag (?:her|him|them|you|it|this|that|the owner)\b(?!\s+down\b)/i,
  /\bflag (?:this|that|it) (?:for|to|with|as)\b/i,
  /\bflagging (?:this|that|it|you|her|him|them|the owner)\b/i,
  /\b(?:i(?:['’]?ll| will)|let me|lemme) tag\b/i,
  /\bpass(?:ing)? (?:this|that|it) (?:along|on|over) to\b/i,
  /\bhand(?:ing|s)?[-\s]?off\b(?=[^.!?\n]*\bowner\b)/i,
  /\bhand(?:ing)? (?:you|this|that|it|her|him|them) off\b(?=[^.!?\n]*\bowner\b)/i,
  /\b(?:i(?:['’]?ll| will)|let me|lemme) escalat/i,
  /\bescalat(?:e|ing|ion)\b(?=[^.!?\n]*\bowner\b)/i,

  // Other first-person / gerund plumbing verbs, object-scoped.
  /\bi(?:['’]?ll| will) mark (?:this|that|it)\b/i,
  /\bmarking (?:this|that|it|you) (?:down|as)\b/i,
  /\bi(?:['’]?ll| will) (?:log|track) (?:this|that|it)\b/i,
  /\blogging (?:this|that|it|you)\b/i,
  /\btracking (?:this|that|it) (?:as|for|in)\b/i,
  /\bsaving (?:this|that|it) (?:as|to|in)\b/i,

  // Bare internal process term.
  /\b(?:tool|function) call\b/i,
];

/**
 * Returns the first machinery/internal-vocab substring found in `text`, or null
 * if the text is clean. The returned substring is for logging/observability.
 */
export function matchInternalVocab(text: string): string | null {
  for (const re of INTERNAL_VOCAB_PATTERNS) {
    const m = re.exec(text);
    if (m) return m[0];
  }
  return null;
}
