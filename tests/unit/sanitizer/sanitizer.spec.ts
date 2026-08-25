import { describe, it, expect } from 'vitest';
import { sanitize } from '../../../src/sanitizer/index.js';

const baseCtx = {
  bookingLink: 'https://example.com/book',
  policy: { maxWordsPerMessage: 40, maxEmojis: 2 },
};

/**
 * What a client actually received on 2026-08-25 13:17, after asking four things
 * in one burst:
 *
 *   "1. balayage usually takes about 3 to 4 hours ... 2. yes, a card on file ...
 *    3. parking is free on Pearl ... 4."
 *
 * Two defects in one message. The model mirrored the numbered list it had been
 * given, and the sentence splitter then read the bare "4." as a finished sentence
 * and left it dangling at the end of the bubble while its answer moved to the
 * next one. The blank lines the model had put between answers were also flattened
 * into spaces before the splitter ever saw them, so four answers arrived as a
 * wall of text instead of separate bubbles.
 */
describe('sanitizer — burst replies', () => {
  const burstCtx = { ...baseCtx, policy: { ...baseCtx.policy, maxMessages: 4 } };

  it('makes one bubble per answer when the model separates them with blank lines', async () => {
    const raw = 'balayage takes about 3 to 4 hours.\n\nyes, we take card.\n\nparking is free on Pearl after 6pm.';
    const result = await sanitize(raw, burstCtx);
    expect(result.messages).toHaveLength(3);
    expect(result.messages[0]).toContain('3 to 4 hours');
    expect(result.messages[1]).toContain('card');
    expect(result.messages[2]).toContain('parking');
    expect(result.modifications).toContain('split_on_paragraphs');
  });

  it('strips a mirrored list marker from the front of each bubble', async () => {
    const raw = '1. balayage takes about 3 to 4 hours.\n\n2. yes, we take card.';
    const result = await sanitize(raw, burstCtx);
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]).toBe('balayage takes about 3 to 4 hours.');
    expect(result.messages[1]).toBe('yes, we take card.');
    expect(result.modifications).toContain('list_markers_stripped');
  });

  it('drops a bubble that is nothing but a dangling number', async () => {
    const raw = 'parking is free on Pearl after 6pm.\n\n4.';
    const result = await sanitize(raw, burstCtx);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toBe('parking is free on Pearl after 6pm.');
  });

  it('leaves a decimal and a price alone', async () => {
    // "3." only counts as a marker when a space follows it, so 3.5 is safe, and a
    // price never matches at all.
    const result = await sanitize('3.5 hours is typical, and it starts at $220.', burstCtx);
    expect(result.messages[0]).toBe('3.5 hours is typical, and it starts at $220.');
  });

  it('still collapses a single stray newline inside one answer', async () => {
    const result = await sanitize('balayage takes\nabout 3 to 4 hours.', burstCtx);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toBe('balayage takes about 3 to 4 hours.');
  });

  it('falls back to word counting when there are more paragraphs than bubbles', async () => {
    const raw = 'one.\n\ntwo.\n\nthree.\n\nfour.\n\nfive.';
    const result = await sanitize(raw, { ...baseCtx, policy: { ...baseCtx.policy, maxMessages: 2 } });
    expect(result.messages.length).toBeLessThanOrEqual(2);
    expect(result.messages.join(' ')).toContain('five');
  });
});

describe('sanitizer — forbidden chars', () => {
  it('replaces em-dash with a comma, absorbing the spaces around it', async () => {
    // Input avoids a banned opener so this test measures the dash only.
    const result = await sanitize('so glad you asked — how are you?', baseCtx);
    expect(result.messages[0]).not.toContain('—');
    expect(result.messages[0]).toBe('so glad you asked, how are you?');
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
    expect(result.messages[0]).toBe('open 9, 5 today'); // style pass lowercases the opener
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
