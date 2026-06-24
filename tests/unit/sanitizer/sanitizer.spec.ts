import { describe, it, expect } from 'vitest';
import { sanitize } from '../../../src/sanitizer/index.js';

const baseCtx = {
  bookingLink: 'https://example.com/book',
  bookingLinkSentInLastNHours: async () => false,
  policy: { maxWordsPerMessage: 40, maxEmojis: 2, bookingLinkDedupWindowHours: 3 },
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

describe('sanitizer — links', () => {
  it('keeps booking link when multiple links present', async () => {
    const result = await sanitize(
      'Check https://example.com/book or https://other.com',
      baseCtx,
    );
    expect(result.messages[0]).toContain('https://example.com/book');
    expect(result.messages[0]).not.toContain('https://other.com');
    expect(result.modifications).toContain('extra_links_stripped');
  });

  it('keeps first link when no booking link present', async () => {
    const result = await sanitize('See https://a.com and https://b.com', baseCtx);
    expect(result.messages[0]).toContain('https://a.com');
    expect(result.messages[0]).not.toContain('https://b.com');
  });

  it('removes booking link if recently sent', async () => {
    const result = await sanitize('Book here https://example.com/book today', {
      ...baseCtx,
      bookingLinkSentInLastNHours: async () => true,
    });
    expect(result.messages[0]).not.toContain('https://example.com/book');
    expect(result.modifications).toContain('booking_link_deduplicated');
  });

  it('keeps booking link when not recently sent', async () => {
    const result = await sanitize('Book here https://example.com/book today', baseCtx);
    expect(result.messages[0]).toContain('https://example.com/book');
    expect(result.modifications).not.toContain('booking_link_deduplicated');
  });
});

describe('sanitizer — word count split', () => {
  it('keeps single message when under cap', async () => {
    const result = await sanitize('Short reply', baseCtx);
    expect(result.messages).toHaveLength(1);
    expect(result.modifications).not.toContain('split_into_multiple');
  });

  it('splits into max two messages on sentence boundary when over cap', async () => {
    const long =
      'Hi there I would love to help you with that color appointment. ' +
      'We do balayage and it usually takes about three hours. ' +
      'Want me to send you the booking link so you can pick a time that works? ' +
      'Sarah is the best for that service and she is around all week long.';
    const result = await sanitize(long, baseCtx);
    expect(result.messages.length).toBeGreaterThanOrEqual(1);
    expect(result.messages.length).toBeLessThanOrEqual(2);
    for (const m of result.messages) {
      expect(m.split(/\s+/).length).toBeLessThanOrEqual(40);
    }
    expect(result.modifications).toContain('split_into_multiple');
  });
});

describe('sanitizer — bug regressions', () => {
  it('strips trailing period from captured URL (dedup recognizes link with sentence period)', async () => {
    const result = await sanitize('Book at https://example.com/book.', {
      ...baseCtx,
      bookingLinkSentInLastNHours: async () => true,
    });
    // Booking link should be stripped because it was recognized despite trailing period
    expect(result.messages[0]).not.toContain('https://example.com/book');
    expect(result.modifications).toContain('booking_link_deduplicated');
  });

  it('does not substring-match similar URLs (booking="https://example.com/book" vs "https://example.com/booking-info")', async () => {
    const result = await sanitize(
      'See https://example.com/booking-info and https://example.com/book',
      baseCtx,
    );
    // The exact booking link must be the kept one, not the substring superset
    expect(result.messages[0]).toContain('https://example.com/book');
    expect(result.messages[0]).not.toContain('https://example.com/booking-info');
    expect(result.modifications).toContain('extra_links_stripped');
  });

  it('preserves URL containing semicolon (jsessionid pattern not mutated by char scrub)', async () => {
    const result = await sanitize('Visit https://example.com/path;jsessionid=abc here', baseCtx);
    expect(result.messages[0]).toContain('https://example.com/path;jsessionid=abc');
    expect(result.messages[0]).not.toContain(',jsessionid');
  });
});
