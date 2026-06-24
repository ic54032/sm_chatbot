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
];

export function containsHandoffPromise(text: string): boolean {
  return HANDOFF_PROMISE_PATTERNS.some((p) => p.test(text));
}
