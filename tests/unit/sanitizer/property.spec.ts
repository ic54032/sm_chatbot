import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { sanitize } from '../../../src/sanitizer/index.js';

const baseCtx = {
  bookingLink: 'https://example.com/book',
  bookingLinkSentInLastN: async () => false,
  policy: { maxWordsPerMessage: 40, maxEmojis: 2, bookingLinkDedupWindow: 3 },
};

const arbText = fc.string({ minLength: 1, maxLength: 800 });

describe('sanitizer invariants (property-based)', () => {
  it('messages length is always between 1 and 2 when not throwing', async () => {
    await fc.assert(
      fc.asyncProperty(arbText, async (text) => {
        try {
          const result = await sanitize(text, baseCtx);
          expect(result.messages.length).toBeGreaterThanOrEqual(1);
          expect(result.messages.length).toBeLessThanOrEqual(2);
        } catch (err) {
          expect((err as Error).name).toBe('SanitizerEmptyOutputError');
        }
      }),
      { numRuns: 2000 },
    );
  });

  it('each message has no forbidden chars and respects word/emoji caps', async () => {
    await fc.assert(
      fc.asyncProperty(arbText, async (text) => {
        try {
          const result = await sanitize(text, baseCtx);
          for (const m of result.messages) {
            expect(m).not.toMatch(/[—–…;]/);
            expect(m.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(40);
            const emojiCount = [...m.matchAll(/\p{Extended_Pictographic}/gu)].length;
            expect(emojiCount).toBeLessThanOrEqual(2);
            const linkCount = [...m.matchAll(/https?:\/\//g)].length;
            expect(linkCount).toBeLessThanOrEqual(1);
          }
        } catch (err) {
          expect((err as Error).name).toBe('SanitizerEmptyOutputError');
        }
      }),
      { numRuns: 2000 },
    );
  });
});
