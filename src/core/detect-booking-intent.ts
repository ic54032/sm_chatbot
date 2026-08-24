/**
 * Anchored booking-intent detection for the empty-output link fallback. When the
 * model returns EMPTY reply text on a clear booking message — it fired a tool but
 * wrote nothing — the backend sends the booking link instead of escalating, so a
 * converting client is never handed to silence.
 *
 * Two families count as intent. The first is ready-to-book. The second is asking
 * for the link again, added 2026-08-24 after a client typed "Could you send it
 * again", the model wrote no text, and the recovery path did not recognise it, so
 * what went back was a generic reassurance line. The phrases mirror the ones the
 * master prompt already lists as an explicit request for the URL.
 *
 * Deliberately ANCHORED phrases, never loose substrings: bare "ready" / "let's
 * do it" collide with non-booking speech ("I'm ready for the bad news, how
 * much?", "let's do it another time"). Every phrase names booking explicitly,
 * and a leading negation ("don't", "not", "maybe") or a trailing deferral
 * ("another time", "yet", "later") vetoes the match.
 *
 * Critically, this reads ONLY the client's message and never a tool call, so it
 * can NEVER send a link merely because some tool fired on a non-booking turn
 * (e.g. set_state_flag(last_quoted_service) on a price question). Regexes are
 * non-global (stateless .exec).
 */
const BOOKING_INTENT_PATTERNS: readonly RegExp[] = [
  /\bbook me in\b/i,
  /\bbook (?:it|me|us) (?:in|now)\b/i,
  /\bready to book\b/i, // covers "i'm ready to book" / "ready to book"
  /\bi want to book\b/i,
  /\bi wanna book\b/i,
  /\bi would like to book\b/i,
  /\bi['’]?d (?:like|love) to book\b/i, // "i'd like to book" / "id like to book"
  /\blet'?s book\b/i,
  /\bsign me up\b/i,

  // Asking for the link again. Only reachable when the model wrote nothing at
  // all, so erring toward sending the URL is the right way to err: the fallback
  // it replaces says nothing useful to someone who just asked for a link.
  /\bsend (?:it|that|the link) again\b/i,
  /\bresend (?:it|that|the link)\b/i,
  /\b(?:where|which)(?:'?s| is) the link\b/i,
  /\b(?:can'?t|cannot|do ?n'?t) (?:find|see) (?:the |that |it )?link\b/i,
  /\bdo ?n'?t see (?:the |a )?link\b/i,
];

// Anchored to the END of the look-behind slice, so only a negation that
// IMMEDIATELY precedes the phrase vetoes it ("don't book me in"). An enthusiastic
// "I can't wait, book me in!" is NOT vetoed — "can't" governs "wait", not "book".
const NEGATION_BEFORE = /\b(?:do ?n'?t|dont|do not|not|never|maybe|won'?t|can'?t)\s*$/i;
const DEFERRAL_AFTER = /^\W*(?:yet\b|another time|later\b|next (?:time|week|month))/i;

export function containsBookingIntent(text: string | null | undefined): boolean {
  if (!text) return false;
  for (const re of BOOKING_INTENT_PATTERNS) {
    const m = re.exec(text);
    if (!m) continue;
    const before = text.slice(Math.max(0, m.index - 24), m.index);
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 24);
    if (NEGATION_BEFORE.test(before)) continue; // "don't book me in", "not ready to book"
    if (DEFERRAL_AFTER.test(after)) continue; // "book me in another time / yet / later"
    return true;
  }
  return false;
}
