import { logger } from '../lib/logger.js';

/** Wider than WebhookAttachment: the GHL API path can return a null url, and
 * those must survive untouched (handle-inbound escalates them separately). */
interface MediaAttachment {
  url: string | null;
  type: 'image' | 'audio' | 'video';
}

/**
 * Correct a media type that the URL extension cannot settle.
 *
 * Instagram voice notes arrive from GHL as `.mp4` files, identical in the URL to
 * a real video, so the extension heuristic labels them `video` and the owner is
 * told "client sent a video" when they actually got a voice note (QA Round 2,
 * item 3.2).
 *
 * Content-Type does NOT settle it: GHL serves both as `video/mp4` (verified
 * against production assets 2026-07-26). The container does. Reading the first
 * few KB of an MP4 shows either a video track or an audio-only one:
 *
 *   video      ftyp brands "isom iso2 avc1 mp41", handler `vide`   (619 KB)
 *   voice note ftyp brands "isom iso2 mp41",      handler `soun`   (12 KB)
 *
 * `avc1`/`hvc1` are video codec brands and `vide`/`soun` are the track handler
 * types inside `moov`, so either one identifies the file. Only genuinely
 * ambiguous extensions are probed, and every failure mode (no range support,
 * timeout, 401, truncated header) leaves the original type untouched — the probe
 * can only improve the guess, never break it.
 */
const AMBIGUOUS_EXT = /\.(mp4|m4a)(?:\?|#|$)/i;
const PROBE_TIMEOUT_MS = 5000;
const PROBE_BYTES = 4095;

type Fetcher = typeof fetch;

/** 'video' | 'audio' | null (undecidable from the bytes we read). */
function classifyContainer(head: Buffer): 'video' | 'audio' | null {
  const ascii = head.toString('latin1');
  // Track handlers are the strongest signal when moov sits near the front.
  if (ascii.includes('vide')) return 'video';
  if (ascii.includes('soun')) return 'audio';
  // Fall back to the ftyp compatible-brand list: a video codec brand means video.
  const ftyp = ascii.indexOf('ftyp');
  if (ftyp >= 0) {
    const brands = ascii.slice(ftyp, ftyp + 40);
    if (/avc1|hvc1|hev1|av01/.test(brands)) return 'video';
  }
  return null;
}

export async function refineMediaTypes<T extends MediaAttachment>(
  attachments: T[],
  fetcher: Fetcher = fetch,
): Promise<T[]> {
  const ambiguous = (a: MediaAttachment): a is T & { url: string } =>
    typeof a.url === 'string' && AMBIGUOUS_EXT.test(a.url);
  if (!attachments.some(ambiguous)) return attachments;

  return Promise.all(
    attachments.map(async (att) => {
      if (!ambiguous(att)) return att;
      try {
        const res = await fetcher(att.url, {
          headers: { Range: `bytes=0-${PROBE_BYTES}` },
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        if (!res.ok) return att;
        const head = Buffer.from(await res.arrayBuffer());
        const verdict = classifyContainer(head);
        if (!verdict) return att;
        if (verdict !== att.type) {
          logger.info({ url: att.url, was: att.type, now: verdict }, 'media type refined from container bytes');
        }
        return { ...att, type: verdict };
      } catch (err) {
        // Best-effort: keep whatever the extension suggested.
        logger.debug({ err, url: att.url }, 'media type probe failed; keeping inferred type');
        return att;
      }
    }),
  );
}
