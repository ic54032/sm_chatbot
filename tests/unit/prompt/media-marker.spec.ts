/**
 * Media markers exist to keep a media-only turn PRESENT and API-VALID in the
 * prompt. A row with text_content = NULL used to render as { role:'user',
 * content:'' }, which OpenAI/Anthropic reject — and because the row stays in the
 * loaded window, every later call on that conversation failed the same way.
 */
import { describe, it, expect } from 'vitest';
import { mediaMarkerFor, MARKER_NO_TEXT, MARKER_NO_IMAGE } from '../../../src/prompt/media-marker.js';

const withAtts = (types: string[], channelType = 'image') => ({
  channelType,
  rawContent: { attachments: types.map((type) => ({ url: `https://x.test/f.${type}`, type })) },
});

describe('mediaMarkerFor', () => {
  // Video, voice note and unviewable media all collapse to one marker: the reply
  // is identical in all three cases, and naming the medium is what made the bot
  // disclose a limitation (see the constants for the production comparison).
  it('asks what they are after for a video', () => {
    expect(mediaMarkerFor(withAtts(['video']))).toBe(MARKER_NO_TEXT);
  });

  it('asks what they are after for a voice note', () => {
    expect(mediaMarkerFor(withAtts(['audio']))).toBe(MARKER_NO_TEXT);
  });

  it('invites a resend for an image that reached us but could not be shown', () => {
    expect(mediaMarkerFor(withAtts(['image']))).toBe(MARKER_NO_IMAGE);
  });

  it('asks what they are after for a shared reel / view-once with NO parseable attachment', () => {
    // GHL drops reel content at ingestion, so attachments_raw arrives as [].
    expect(mediaMarkerFor({ channelType: 'image', rawContent: { attachments: [] } })).toBe(MARKER_NO_TEXT);
  });

  it('a burst carrying both a video and an image asks rather than inviting a resend', () => {
    expect(mediaMarkerFor(withAtts(['image', 'video']))).toBe(MARKER_NO_TEXT);
  });

  it('names no medium and no capability, in either marker', () => {
    // The whole point of the 2026-08-24 rewrite. If a medium creeps back into
    // one of these strings, the admission behaviour comes back with it.
    for (const marker of [MARKER_NO_TEXT, MARKER_NO_IMAGE]) {
      expect(marker).not.toMatch(/video|voice|audio|reel|photo|attachment|clip/i);
      expect(marker).not.toMatch(/can'?t|cannot|unable|receiv|support/i);
      expect(marker).not.toMatch(/[—–]/); // no dash to echo back
    }
  });

  it('returns null for a plain text turn (no marker needed)', () => {
    expect(mediaMarkerFor({ channelType: 'text', rawContent: { attachments: [] } })).toBeNull();
  });

  it('tolerates malformed rawContent instead of throwing', () => {
    expect(mediaMarkerFor({ channelType: 'text', rawContent: null })).toBeNull();
    expect(mediaMarkerFor({ channelType: 'text', rawContent: 'not-an-object' })).toBeNull();
    expect(mediaMarkerFor({ channelType: 'image', rawContent: { attachments: 'nope' } })).toBe(MARKER_NO_TEXT);
  });
});
