import { logger } from '../lib/logger.js';

/** Wider than WebhookAttachment: the GHL API path can return a null url, and
 * those must survive untouched (handle-inbound escalates them separately). */
interface MediaAttachment {
  url: string | null;
  type: 'image' | 'audio' | 'video';
  /**
   * True once the container bytes have SETTLED whether an ambiguous .mp4 is a
   * video or a voice note. Absent or false means the type is still the extension's
   * guess, which for .mp4 is always 'video'.
   *
   * The owner's notification depends on the difference. A voice note was announced
   * to her as a video for three rounds running, so the labels were merged into one
   * hedge that covered both. That hedge is now needed only where it is TRUE: this
   * flag lets a settled type say exactly what arrived and leaves the vague wording
   * for the probe timeouts, instead of applying it to every case.
   */
  typeConfirmed?: boolean;
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

/**
 * The verdict AND the evidence behind it.
 *
 * The evidence is returned so the caller can log it. Knowing only that a probe
 * said "video" does not tell you whether Instagram changed what it sends, and the
 * whole voice-note-labelled-as-video saga came from having no visibility into
 * this step. `brands` is the ftyp compatible-brand list, which is the closest
 * thing to a format fingerprint these files carry.
 */
function classifyContainer(head: Buffer): {
  verdict: 'video' | 'audio' | null;
  by: 'handler' | 'brand' | 'none';
  brands: string;
} {
  const ascii = head.toString('latin1');
  const ftyp = ascii.indexOf('ftyp');
  const brands = ftyp >= 0 ? ascii.slice(ftyp, ftyp + 32).replace(/[^\x20-\x7e]/g, ' ').trim() : '';

  // Track handlers are the strongest signal when moov sits near the front.
  if (ascii.includes('vide')) return { verdict: 'video', by: 'handler', brands };
  if (ascii.includes('soun')) return { verdict: 'audio', by: 'handler', brands };
  // Fall back to the compatible-brand list: a video codec brand means video.
  if (/avc1|hvc1|hev1|av01/.test(brands)) return { verdict: 'video', by: 'brand', brands };
  return { verdict: null, by: 'none', brands };
}

export async function refineMediaTypes<T extends MediaAttachment>(
  attachments: T[],
  fetcher: Fetcher = fetch,
  // The flag is added here, so it has to appear in the return type: callers pass
  // in shapes that do not carry it yet.
): Promise<Array<T & { typeAmbiguous?: boolean }>> {
  const ambiguous = (a: MediaAttachment): a is T & { url: string } =>
    typeof a.url === 'string' && AMBIGUOUS_EXT.test(a.url);
  if (!attachments.some(ambiguous)) return attachments;

  return Promise.all(
    attachments.map(async (att) => {
      if (!ambiguous(att)) return att; // the extension already settles it
      try {
        const res = await fetcher(att.url, {
          headers: { Range: `bytes=0-${PROBE_BYTES}` },
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        if (!res.ok) {
          logger.warn({ url: att.url, status: res.status }, 'media probe: range request refused, type stays ambiguous');
          return { ...att, typeAmbiguous: true };
        }
        const head = Buffer.from(await res.arrayBuffer());
        const { verdict, by, brands } = classifyContainer(head);
        // Logged on EVERY probe, not only when the verdict differs from the
        // extension. Silence used to mean two different things, "probe confirmed
        // the guess" and "probe never ran", and telling them apart is the whole
        // point of having a probe. `brands` is the format fingerprint: if
        // Instagram changes what it sends, this line is where it shows up first.
        logger.info(
          { url: att.url, extensionSaid: att.type, verdict, by, brands, bytes: head.length },
          'media probe result',
        );
        if (!verdict) return { ...att, typeAmbiguous: true };
        return { ...att, type: verdict };
      } catch (err) {
        // Keep whatever the extension suggested, but say that it is a guess. The
        // extension calls every Instagram voice note a video, so an unprobed .mp4
        // is a coin toss and the owner should not be told otherwise.
        // Deliberately warn, not debug. Every Instagram video and voice note is a
        // .mp4, so this branch decides what the owner is told about REAL media,
        // and a hedged notification is a worse notification. If this line turns
        // out to be common, the split labels are not buying anything and the
        // probe needs attention rather than the labels.
        logger.warn({ err, url: att.url }, 'media type probe failed; owner gets the hedged label');
        return { ...att, typeAmbiguous: true };
      }
    }),
  );
}
