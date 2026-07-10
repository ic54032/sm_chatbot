// GPT-4o intermittently writes tool invocations as literal bracket text in its
// reply — mimicking the master prompt's example notation ("[mark_link_sent()]")
// — instead of (or in addition to) firing native function calls. Seen in
// production on 2026-07-06: "[get_started_link()]" appended to a booking reply,
// and a full "[escalate_to_owner(reason=...)]" block printed to a client while
// the native tool never fired.
//
// This module finds those bracket patterns, strips them from the outgoing text,
// and returns them parsed so the orchestrator can RECOVER the intent (force the
// escalation, record the link event) rather than just cosmetically deleting it.
//
// Implemented as a small scanner, not a single regex: the argument list can
// contain quoted strings that themselves contain ")]" or bracket syntax, which
// a non-greedy regex would truncate on — leaving residual tool syntax in the
// client-visible text, the exact leak class this module exists to prevent.

export interface LeakedToolCall {
  name: string;
  /** key=value pairs found in the argument list (value keeps its literal type) */
  named: Record<string, string | boolean | number>;
  /** bare positional args in source order: strings, booleans, numbers */
  positional: Array<string | boolean | number>;
  raw: string;
}

export interface ExtractResult {
  cleanedText: string;
  calls: LeakedToolCall[];
}

function isSpace(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

const NAME_REGEX = /^[A-Za-z_][A-Za-z0-9_]*/;

// Single left-to-right token pass so positional order is preserved and a
// key="v" fragment INSIDE a quoted string can never be misread as a named arg.
// Bare identifiers count as positional strings — leaks in Python-kwarg style
// ("[set_state_flag(client_is_hesitant, true)]") omit the quotes.
const ARG_TOKEN_REGEX =
  /([A-Za-z_][A-Za-z0-9_]*)\s*=\s*("(?:[^"\\]|\\.)*"|true|false|-?\d+(?:\.\d+)?|[A-Za-z_][A-Za-z0-9_]*)|("(?:[^"\\]|\\.)*")|\b(true|false)\b|(-?\d+(?:\.\d+)?)|([A-Za-z_][A-Za-z0-9_]*)/g;

function literalValue(tok: string): string | boolean | number {
  if (tok.startsWith('"')) return tok.slice(1, -1).replace(/\\(.)/g, '$1');
  if (tok === 'true') return true;
  if (tok === 'false') return false;
  if (/^-?\d/.test(tok)) return Number(tok);
  return tok; // bare identifier — treat as string
}

function parseArgs(body: string): Pick<LeakedToolCall, 'named' | 'positional'> {
  const named: LeakedToolCall['named'] = {};
  const positional: LeakedToolCall['positional'] = [];
  for (const m of body.matchAll(ARG_TOKEN_REGEX)) {
    if (m[1] !== undefined) named[m[1]] = literalValue(m[2]);
    else if (m[3] !== undefined) positional.push(literalValue(m[3]));
    else if (m[4] !== undefined) positional.push(m[4] === 'true');
    else if (m[5] !== undefined) positional.push(Number(m[5]));
    else if (m[6] !== undefined) positional.push(m[6]);
  }
  return { named, positional };
}

/**
 * Try to parse a leaked call starting at text[start] === '['. Returns null when
 * the bracket is NOT a tool-call shape, so legitimate bracketed prose survives:
 * - "[image only, no caption]" / "[booking.url]" — no "(" at all
 * - "[gloss (add-on)]" / "[book (free consult)](url)" — "(" is not IMMEDIATELY
 *   after the identifier; real leaks are always "name(".
 */
function tryParseCall(text: string, start: number): { call: LeakedToolCall; end: number } | null {
  let i = start + 1;
  while (isSpace(text[i])) i++;
  const nameMatch = NAME_REGEX.exec(text.slice(i));
  if (!nameMatch) return null;
  const name = nameMatch[0];
  i += name.length;
  if (text[i] !== '(') return null;
  i++;

  let body = '';
  let depth = 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      // consume a whole quoted string (backslash escapes respected) so ")" or
      // ")]" inside it can't terminate the call body
      let str = '"';
      i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\' && i + 1 < text.length) {
          str += text[i] + text[i + 1];
          i += 2;
        } else {
          str += text[i];
          i++;
        }
      }
      if (i >= text.length) return null; // unterminated string — not a call
      str += '"';
      i++;
      body += str;
    } else if (ch === '(') {
      depth++;
      body += ch;
      i++;
    } else if (ch === ')') {
      depth--;
      i++;
      if (depth === 0) break;
      body += ch;
    } else {
      body += ch;
      i++;
    }
  }
  if (depth !== 0) return null;
  while (isSpace(text[i])) i++;
  if (text[i] !== ']') return null;
  i++;

  const { named, positional } = parseArgs(body);
  return { call: { name, named, positional, raw: text.slice(start, i) }, end: i };
}

export function extractLeakedToolCalls(text: string): ExtractResult {
  const calls: LeakedToolCall[] = [];
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] === '[') {
      const parsed = tryParseCall(text, i);
      if (parsed) {
        calls.push(parsed.call);
        i = parsed.end;
        continue;
      }
    }
    out += text[i];
    i++;
  }
  const cleanedText = out
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { cleanedText, calls };
}
