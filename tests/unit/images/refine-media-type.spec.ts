/**
 * QA Round 2 item 3.2: an Instagram voice note arrives from GHL as a ".mp4",
 * identical in the URL to a real video, so the extension heuristic told the
 * owner "client sent a video" when they got a voice note. The server knows.
 */
import { describe, it, expect, vi } from 'vitest';
import { refineMediaTypes } from '../../../src/images/refine-media-type.js';

const headResponse = (contentType: string | null) =>
  ({ headers: { get: () => contentType } }) as unknown as Response;

describe('refineMediaTypes', () => {
  it('relabels an .mp4 as audio when the server says audio/mp4', async () => {
    const fetcher = vi.fn(async () => headResponse('audio/mp4'));
    const out = await refineMediaTypes(
      [{ url: 'https://x.test/voice.mp4', type: 'video' as const }],
      fetcher as unknown as typeof fetch,
    );
    expect(out[0].type).toBe('audio');
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: 'HEAD' });
  });

  it('keeps video when the server says video/mp4', async () => {
    const fetcher = vi.fn(async () => headResponse('video/mp4'));
    const out = await refineMediaTypes(
      [{ url: 'https://x.test/clip.mp4', type: 'video' as const }],
      fetcher as unknown as typeof fetch,
    );
    expect(out[0].type).toBe('video');
  });

  it('does not probe an unambiguous extension (no wasted request)', async () => {
    const fetcher = vi.fn(async () => headResponse('image/jpeg'));
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

  it('keeps the inferred type when the probe fails (best-effort only)', async () => {
    const fetcher = vi.fn(async () => {
      throw new Error('timeout');
    });
    const out = await refineMediaTypes(
      [{ url: 'https://x.test/voice.mp4', type: 'video' as const }],
      fetcher as unknown as typeof fetch,
    );
    expect(out[0].type).toBe('video');
  });

  it('keeps the inferred type when the server sends no content-type', async () => {
    const fetcher = vi.fn(async () => headResponse(null));
    const out = await refineMediaTypes(
      [{ url: 'https://x.test/voice.mp4', type: 'video' as const }],
      fetcher as unknown as typeof fetch,
    );
    expect(out[0].type).toBe('video');
  });

  it('passes through attachments with no URL (image_without_url must still escalate)', async () => {
    const fetcher = vi.fn(async () => headResponse('audio/mp4'));
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
