import { AttachmentFetchError, ImageTooLargeError } from './errors.js';

const MAX_INPUT_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10_000;

type Fetcher = typeof fetch;

export async function fetchAttachment(url: string, pit: string, fetcher: Fetcher = fetch): Promise<Buffer> {
  let res = await fetcher(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });

  if (!res.ok && (res.status === 401 || res.status === 403)) {
    res = await fetcher(url, {
      headers: { Authorization: `Bearer ${pit}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  }

  if (!res.ok) {
    throw new AttachmentFetchError(res.status, url);
  }

  const declared = parseInt(res.headers.get('content-length') ?? '0', 10);
  if (declared > MAX_INPUT_BYTES) {
    throw new ImageTooLargeError(declared);
  }

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_INPUT_BYTES) {
    throw new ImageTooLargeError(buf.length);
  }
  return buf;
}
