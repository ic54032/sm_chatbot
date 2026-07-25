/**
 * Media markers exist to keep a media-only turn PRESENT and API-VALID in the
 * prompt. A row with text_content = NULL used to render as { role:'user',
 * content:'' }, which OpenAI/Anthropic reject — and because the row stays in the
 * loaded window, every later call on that conversation failed the same way.
 */
import { describe, it, expect } from 'vitest';
import {
  mediaMarkerFor,
  MARKER_VIDEO,
  MARKER_VOICE,
  MARKER_PHOTO_FAILED,
  MARKER_UNVIEWABLE,
} from '../../../src/prompt/media-marker.js';

const withAtts = (types: string[], channelType = 'image') => ({
  channelType,
  rawContent: { attachments: types.map((type) => ({ url: `https://x.test/f.${type}`, type })) },
});

describe('mediaMarkerFor', () => {
  it('describes a video (GHL delivers these with a real .mp4 URL)', () => {
    expect(mediaMarkerFor(withAtts(['video']))).toBe(MARKER_VIDEO);
  });

  it('describes a voice note', () => {
    expect(mediaMarkerFor(withAtts(['audio']))).toBe(MARKER_VOICE);
  });

  it('describes an image that reached us but could not be shown', () => {
    expect(mediaMarkerFor(withAtts(['image']))).toBe(MARKER_PHOTO_FAILED);
  });

  it('describes a shared reel / view-once: non-text message with NO parseable attachment', () => {
    // GHL drops reel content at ingestion, so attachments_raw arrives as [].
    expect(mediaMarkerFor({ channelType: 'image', rawContent: { attachments: [] } })).toBe(MARKER_UNVIEWABLE);
  });

  it('video wins over image when a burst carried both', () => {
    expect(mediaMarkerFor(withAtts(['image', 'video']))).toBe(MARKER_VIDEO);
  });

  it('returns null for a plain text turn (no marker needed)', () => {
    expect(mediaMarkerFor({ channelType: 'text', rawContent: { attachments: [] } })).toBeNull();
  });

  it('tolerates malformed rawContent instead of throwing', () => {
    expect(mediaMarkerFor({ channelType: 'text', rawContent: null })).toBeNull();
    expect(mediaMarkerFor({ channelType: 'text', rawContent: 'not-an-object' })).toBeNull();
    expect(mediaMarkerFor({ channelType: 'image', rawContent: { attachments: 'nope' } })).toBe(MARKER_UNVIEWABLE);
  });
});
