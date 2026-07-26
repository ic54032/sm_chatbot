import { describe, it, expect } from 'vitest';
import { sanitize } from '../../../src/sanitizer/index.js';

const baseCtx = {
  bookingLink: 'https://example.com/book',
  policy: { maxWordsPerMessage: 40, maxEmojis: 2 },
};

describe('sanitizer — forbidden chars', () => {
  it('replaces em-dash with a comma, absorbing the spaces around it', async () => {
    const result = await sanitize('Hi there — how are you?', baseCtx);
    expect(result.messages[0]).not.toContain('—');
    expect(result.messages[0]).toBe('Hi there, how are you?');
    expect(result.modifications).toContain('forbidden_chars_scrubbed');
  });

  // QA Round 2, item 4.7: a bare hyphen glued the words either side together and
  // read as an improvised dash, which the style rules ban.
  it('does not produce a word-gluing hyphen (the "availability-just" bug)', async () => {
    const result = await sanitize('live availability—just grab a spot', baseCtx);
    expect(result.messages[0]).toBe('live availability, just grab a spot');
    expect(result.messages[0]).not.toContain('-');
  });

  it('replaces en-dash with a comma', async () => {
    const result = await sanitize('Open 9–5 today', baseCtx);
    expect(result.messages[0]).not.toContain('–');
    expect(result.messages[0]).toBe('Open 9, 5 today');
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

  it('keeps the booking link — the sanitizer no longer strips it across turns', async () => {
    // Across-turn dedup was removed (production 2026-07-11): stripping the link
    // broke legitimate re-pastes ("here it is again for you:" with no URL). The
    // prompt decides when to re-paste vs refer conversationally; the sanitizer
    // never removes the booking link now.
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
  it('strips trailing period from a captured URL so the clean URL survives', async () => {
    const result = await sanitize('Book at https://example.com/book.', baseCtx);
    // The URL is preserved (trailing sentence period trimmed off the capture).
    expect(result.messages[0]).toContain('https://example.com/book');
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

// Three defects found by reading production output on 2026-07-26. None of them
// were visible to the existing suite because no test sent a long reply that
// also contained a link.
describe('sanitizer — split must never damage the reply', () => {
  const longCtx = { bookingLink: 'https://lumenhairstudio.glossgenius.com/book', policy: { maxWordsPerMessage: 40, maxEmojis: 2 } };

  it('keeps a URL intact when the reply is long enough to split (production 2026-07-15)', async () => {
    // The splitter used to read the dots in a domain as sentence boundaries and
    // rejoin the pieces with spaces, shipping a dead link to the client.
    const raw =
      'balayage at our studio runs between $220 and $320 depending on your length and density, ' +
      'and that includes the toner so there are no surprises at the end of the appointment. ' +
      'the very best first step is a quick consult so renata can look at your hair in person ' +
      'and map out a plan that keeps it healthy, you can grab a time right here: ' +
      'https://lumenhairstudio.glossgenius.com/book';

    const result = await sanitize(raw, longCtx);

    expect(result.modifications).toContain('split_into_multiple');
    const joined = result.messages.join(' ');
    expect(joined).toContain('https://lumenhairstudio.glossgenius.com/book');
    expect(joined).not.toContain('glossgenius. com');
    expect(joined).not.toContain('lumenhairstudio. ');
  });

  it('loses no words when the reply needs more bubbles than the cap allows (production 2026-07-21)', async () => {
    // 104 words used to become 2 x 40 with ~24 words silently discarded.
    const raw = Array.from({ length: 104 }, (_, i) => `word${i}`).join(' ') + '.';

    const result = await sanitize(raw, longCtx);

    expect(result.messages.length).toBeLessThanOrEqual(2); // bubble count still bounded
    const joined = result.messages.join(' ');
    for (const marker of ['word0', 'word50', 'word79', 'word103']) {
      expect(joined).toContain(marker);
    }
  });

  it('never truncates a single sentence that exceeds the word cap', async () => {
    const raw = Array.from({ length: 55 }, (_, i) => `w${i}`).join(' '); // one sentence, no terminator

    const result = await sanitize(raw, longCtx);

    expect(result.messages.join(' ')).toContain('w54'); // the tail survives
  });

  it('still splits a normal two-sentence reply at the sentence boundary', async () => {
    const raw =
      'balayage runs between $220 and $320 depending on your length and density, toner included so there are no surprises. ' +
      'the best first step is a quick consult with renata so she can map out a plan that keeps your hair healthy.';

    const result = await sanitize(raw, longCtx);

    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]).toMatch(/[.!?]$/); // clean break, not mid-thought
  });
});
