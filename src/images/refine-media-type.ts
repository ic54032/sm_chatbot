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
 * item 3.2). The server knows the difference, so ask it: a HEAD request returns
 * `audio/mp4` for a voice note and `video/mp4` for a video.
 *
 * Only genuinely ambiguous attachments are probed — a `.mov` or a `.jpeg` needs
 * no network call. Every failure mode (timeout, 401, no header, junk value)
 * leaves the original type untouched, so this can only ever improve the guess.
 */
const AMBIGUOUS_EXT = /\.(mp4|m4a)(?:\?|#|$)/i;
const HEAD_TIMEOUT_MS = 4000;

type Fetcher = typeof fetch;

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
          method: 'HEAD',
          signal: AbortSignal.timeout(HEAD_TIMEOUT_MS),
        });
        const contentType = res.headers.get('content-type')?.toLowerCase() ?? '';
        if (contentType.startsWith('audio/')) {
          if (att.type !== 'audio') {
            logger.info({ url: att.url, contentType, was: att.type }, 'media type refined to audio via Content-Type');
          }
          return { ...att, type: 'audio' as const };
        }
        if (contentType.startsWith('video/')) return { ...att, type: 'video' as const };
        return att;
      } catch (err) {
        // The probe is best-effort: keep whatever the extension suggested.
        logger.debug({ err, url: att.url }, 'media type probe failed; keeping inferred type');
        return att;
      }
    }),
  );
}
