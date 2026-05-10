import { describe, it, expect } from 'vitest';
import { sanitize } from '../../../src/sanitizer/index.js';

const baseCtx = {
  bookingLink: 'https://example.com/book',
  bookingLinkSentInLastN: async () => false,
  policy: { maxWordsPerMessage: 40, maxEmojis: 2, bookingLinkDedupWindow: 3 },
};

describe('sanitizer — forbidden chars', () => {
  it('replaces em-dash with hyphen', async () => {
    const result = await sanitize('Hi there — how are you?', baseCtx);
    expect(result.messages[0]).not.toContain('—');
    expect(result.modifications).toContain('forbidden_chars_scrubbed');
  });

  it('replaces en-dash with hyphen', async () => {
    const result = await sanitize('Open 9–5 today', baseCtx);
    expect(result.messages[0]).not.toContain('–');
    expect(result.modifications).toContain('forbidden_chars_scrubbed');
  });

  it('removes ellipsis', async () => {
    const result = await sanitize('So… that works', baseCtx);
    expect(result.messages[0]).not.toContain('…');
  });

  it('replaces semicolons with comma', async () => {
    const result = await sanitize('First; second', baseCtx);
    expect(result.messages[0]).not.toContain(';');
    expect(result.messages[0]).toContain(',');
  });
});

describe('sanitizer — emoji cap', () => {
  it('keeps two emojis, drops the rest', async () => {
    const result = await sanitize('Hi 💇‍♀️ love 💖 it 🎉 yay 🌟', baseCtx);
    const emojiCount = [...result.messages[0].matchAll(/\p{Extended_Pictographic}/gu)].length;
    expect(emojiCount).toBeLessThanOrEqual(2);
    expect(result.modifications).toContain('emojis_capped');
  });

  it('does not modify text below cap', async () => {
    const result = await sanitize('Hi 💇‍♀️ love it', baseCtx);
    expect(result.modifications).not.toContain('emojis_capped');
  });
});
