/**
 * QA Round 2 item 3.2: an Instagram voice note arrives from GHL as a ".mp4",
 * identical in the URL to a real video, so the extension heuristic told the
 * owner "client sent a video" when they got a voice note.
 *
 * Content-Type does not settle it either — GHL serves BOTH as video/mp4
 * (verified against production assets 2026-07-26). The container does: the byte
 * sequences below are taken from the real files.
 */
import { describe, it, expect, vi } from 'vitest';
import { refineMediaTypes } from '../../../src/images/refine-media-type.js';

/** Head bytes shaped like the real production assets. */
const VIDEO_HEAD = Buffer.from('\0\0\0 ftypisom\0\0\0isomiso2avc1mp41....moov....hdlrvide', 'latin1');
const VOICE_HEAD = Buffer.from('\0\0\0ftypisom\0\0\0isomiso2mp41....moov....hdlrsoun', 'latin1');
const NO_MOOV_VIDEO_HEAD = Buffer.from('\0\0\0 ftypisom\0\0\0isomiso2avc1mp41....mdat....', 'latin1');

const rangeResponse = (body: Buffer, ok = true) =>
  ({ ok, arrayBuffer: async () => body }) as unknown as Response;

describe('refineMediaTypes', () => {
  it('relabels a voice note as audio (soun track, no avc1) — the production failure', async () => {
    const fetcher = vi.fn(async () => rangeResponse(VOICE_HEAD));
    const out = await refineMediaTypes(
      [{ url: 'https://x.test/67689215.mp4', type: 'video' as const }],
      fetcher as unknown as typeof fetch,
    );
    expect(out[0].type).toBe('audio');
    // Only the first few KB are pulled, never the whole file.
    expect(fetcher.mock.calls[0][1]).toMatchObject({ headers: { Range: expect.stringContaining('bytes=0-') } });
  });

  it('keeps a real video as video (vide track)', async () => {
    const fetcher = vi.fn(async () => rangeResponse(VIDEO_HEAD));
    const out = await refineMediaTypes(
      [{ url: 'https://x.test/59646235.mp4', type: 'video' as const }],
      fetcher as unknown as typeof fetch,
    );
    expect(out[0].type).toBe('video');
  });

  it('falls back to the ftyp codec brand when no track handler is in range', async () => {
    const fetcher = vi.fn(async () => rangeResponse(NO_MOOV_VIDEO_HEAD));
    const out = await refineMediaTypes(
      [{ url: 'https://x.test/clip.mp4', type: 'audio' as const }],
      fetcher as unknown as typeof fetch,
    );
    expect(out[0].type).toBe('video');
  });

  it('does not probe an unambiguous extension (no wasted request)', async () => {
    const fetcher = vi.fn(async () => rangeResponse(VIDEO_HEAD));
    const out = await refineMediaTypes(
      [
        { url: 'https://x.test/pic.jpeg', type: 'image' as const },
        { url: 'https://x.test/clip.mov', type: 'video' as const },
      ],
      fetcher as unknown as typeof fetch,
    );
    expect(fetcher).not.toHaveBeenCalled();
    expect(out.map((a) => a.type)).toEqual(['image', 'video']);
  });

  it('keeps the inferred type when the probe throws, errors, or is undecidable', async () => {
    const throwing = vi.fn(async () => {
      throw new Error('timeout');
    });
    const notOk = vi.fn(async () => rangeResponse(VOICE_HEAD, false));
    const undecidable = vi.fn(async () => rangeResponse(Buffer.from('nothing useful here', 'latin1')));

    for (const fetcher of [throwing, notOk, undecidable]) {
      const out = await refineMediaTypes(
        [{ url: 'https://x.test/voice.mp4', type: 'video' as const }],
        fetcher as unknown as typeof fetch,
      );
      expect(out[0].type).toBe('video');
    }
  });

  it('passes through attachments with no URL (image_without_url must still escalate)', async () => {
    const fetcher = vi.fn(async () => rangeResponse(VOICE_HEAD));
    const out = await refineMediaTypes(
      [
        { url: null, type: 'image' as const },
        { url: 'https://x.test/voice.mp4', type: 'video' as const },
      ],
      fetcher as unknown as typeof fetch,
    );
    expect(out[0]).toEqual({ url: null, type: 'image' });
    expect(out[1].type).toBe('audio');
  });
});
