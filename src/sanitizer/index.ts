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

/** Korak 1 stub: identity passthrough. Replaced with full pipeline in Korak 2. */
export async function sanitize(raw: string, _ctx: SanitizeContext): Promise<SanitizeResult> {
  const text = raw.trim();
  if (text.length === 0) {
    throw new SanitizerEmptyOutputError(raw, []);
  }
  return { messages: [text], modifications: [] };
}
