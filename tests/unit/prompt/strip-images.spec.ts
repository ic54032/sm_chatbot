/**
 * The corrective retry used to re-send every photo. With images counting toward
 * the tokens-per-minute limit and a turn measuring 13-18k tokens, that put ~38k
 * on the wire inside two seconds against a 30k/min budget — a guaranteed 429,
 * which the code then mislabelled as an outage (production 2026-08-08, -08-10).
 */
import { describe, it, expect } from 'vitest';
import { withoutImageBlocks } from '../../../src/prompt/strip-images.js';

// The marker states the ABSENCE of the photo and forbids describing it. An
// earlier wording ("[photo already reviewed]") asserted the model had seen
// something it never received, which invited an invented photo description.
const MARKER = '[the photo is not attached to this turn, do not describe it]';

const img = { type: 'image' as const, mediaType: 'image/jpeg', base64: 'AAAA' };

describe('withoutImageBlocks', () => {
  it('removes image blocks but keeps the caption and marks that a photo existed', () => {
    const out = withoutImageBlocks([
      { role: 'user', content: [img, { type: 'text', text: 'can you fix this?' }] },
    ]);
    expect(out[0].content).toBe(`can you fix this? ${MARKER}`);
  });

  it('never emits empty content for an image-only turn (the APIs reject it)', () => {
    const out = withoutImageBlocks([{ role: 'user', content: [img] }]);
    expect(out[0].content).toBe(MARKER);
  });

  it('leaves plain text turns untouched', () => {
    const messages = [
      { role: 'user' as const, content: 'how much is balayage?' },
      { role: 'assistant' as const, content: 'around $220 to $320 🤍' },
    ];
    expect(withoutImageBlocks(messages)).toEqual(messages);
  });

  it('drops every image across a multi-photo burst', () => {
    const out = withoutImageBlocks([
      { role: 'user', content: [img, img, img, { type: 'text', text: 'these three' }] },
    ]);
    expect(out[0].content).toBe(`these three ${MARKER}`);
    expect(JSON.stringify(out)).not.toContain('base64');
    expect(JSON.stringify(out)).not.toContain('AAAA');
  });

  it('preserves message order and roles', () => {
    const out = withoutImageBlocks([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hey 🤍' },
      { role: 'user', content: [img, { type: 'text', text: 'look' }] },
    ]);
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(out[2].content).toBe(`look ${MARKER}`);
  });
});
