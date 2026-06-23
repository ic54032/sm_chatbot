// Defensive parser for GHL webhook attachment data.
// GHL renders {{message.attachments}} in unspecified format — could be a
// JSON-encoded string, a comma-separated URL list, a single URL, or an
// already-parsed array. This module normalizes all observed/plausible shapes
// to the same array-of-objects format the rest of the image pipeline expects.

export interface WebhookAttachment {
  url: string;
  type: 'image' | 'audio' | 'video';
}

const URL_REGEX = /^https?:\/\//;

// Detect media type from URL extension. GHL's merge tag system doesn't pass
// the original content_type alongside the URL, so we infer from path. Anything
// that doesn't match a known video/audio extension defaults to image (the most
// common case in IG DMs).
const VIDEO_EXT_REGEX = /\.(mp4|mov|webm|m4v|avi|mkv)(?:\?|#|$)/i;
const AUDIO_EXT_REGEX = /\.(mp3|m4a|ogg|wav|aac|opus)(?:\?|#|$)/i;

function inferTypeFromUrl(url: string): 'image' | 'audio' | 'video' {
  if (VIDEO_EXT_REGEX.test(url)) return 'video';
  if (AUDIO_EXT_REGEX.test(url)) return 'audio';
  return 'image';
}

export function parseWebhookAttachments(rawValue: unknown): WebhookAttachment[] {
  if (rawValue === null || rawValue === undefined) return [];

  // Case 1: GHL sent it as a string (most likely with quoted Option A format).
  if (typeof rawValue === 'string') {
    const trimmed = rawValue.trim();
    if (trimmed === '' || trimmed === 'null' || trimmed === 'undefined') return [];

    // 1a. Try JSON.parse — handles arrays of objects or arrays of URL strings.
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed);
        return normalizeArray(Array.isArray(parsed) ? parsed : [parsed]);
      } catch {
        // fall through to URL heuristics
      }
    }

    // 1b. Comma-separated URLs (must check BEFORE single-URL, otherwise the
    //     URL_REGEX would match the leading "https://" of the whole string).
    if (trimmed.includes(',')) {
      const parts = trimmed
        .split(',')
        .map((p) => p.trim())
        .filter((p) => URL_REGEX.test(p));
      if (parts.length > 0) return parts.map((url) => ({ url, type: inferTypeFromUrl(url) }));
    }

    // 1c. Single URL string.
    if (URL_REGEX.test(trimmed)) {
      return [{ url: trimmed, type: inferTypeFromUrl(trimmed) }];
    }

    return [];
  }

  // Case 2: GHL sent it as an array directly (Option B path or future API change).
  if (Array.isArray(rawValue)) {
    return normalizeArray(rawValue);
  }

  // Case 3: Single object (rare but possible).
  if (typeof rawValue === 'object') {
    return normalizeArray([rawValue]);
  }

  return [];
}

function normalizeArray(items: unknown[]): WebhookAttachment[] {
  const result: WebhookAttachment[] = [];
  for (const item of items) {
    if (typeof item === 'string' && URL_REGEX.test(item)) {
      result.push({ url: item, type: inferTypeFromUrl(item) });
      continue;
    }
    if (typeof item !== 'object' || item === null) continue;

    const obj = item as Record<string, unknown>;
    // Try common URL field names.
    const urlCandidate = obj.url ?? obj.URL ?? obj.imageUrl ?? obj.image_url ?? obj.mediaUrl ?? obj.media_url;
    if (typeof urlCandidate !== 'string' || !URL_REGEX.test(urlCandidate)) continue;

    // Try common type field names. Default to 'image' since IG DM attachments are
    // overwhelmingly photos and our caller already drops video/audio at the handler.
    const typeCandidate = obj.type ?? obj.contentType ?? obj.content_type ?? obj.mimeType ?? obj.mime_type;
    const normalizedType = normalizeType(typeCandidate);

    result.push({ url: urlCandidate, type: normalizedType });
  }
  return result;
}

function normalizeType(raw: unknown): 'image' | 'audio' | 'video' {
  if (typeof raw !== 'string') return 'image';
  const lower = raw.toLowerCase();
  if (lower.includes('video')) return 'video';
  if (lower.includes('audio')) return 'audio';
  return 'image';
}
