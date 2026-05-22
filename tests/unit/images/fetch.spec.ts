import { describe, it, expect } from 'vitest';
import { fetchAttachment } from '../../../src/images/fetch.js';
import { AttachmentFetchError, ImageTooLargeError } from '../../../src/images/errors.js';

function mockResponse(status: number, body: Uint8Array | string = '', headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers });
}

describe('fetchAttachment', () => {
  it('returns buffer on plain 200', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const fetcher: typeof fetch = async () => mockResponse(200, bytes, { 'content-length': '4' });
    const buf = await fetchAttachment('https://x.test/img.jpg', 'pit-xyz', fetcher);
    expect(buf).toEqual(Buffer.from(bytes));
  });

  it('retries with Bearer header on 401 and succeeds', async () => {
    const calls: { url: string; auth?: string }[] = [];
    const bytes = new Uint8Array([9, 9]);
    const fetcher: typeof fetch = async (url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ url: String(url), auth: headers['Authorization'] });
      if (calls.length === 1) return mockResponse(401);
      return mockResponse(200, bytes, { 'content-length': '2' });
    };
    const buf = await fetchAttachment('https://x.test/img.jpg', 'pit-xyz', fetcher);
    expect(calls).toHaveLength(2);
    expect(calls[0].auth).toBeUndefined();
    expect(calls[1].auth).toBe('Bearer pit-xyz');
    expect(buf).toEqual(Buffer.from(bytes));
  });

  it('throws AttachmentFetchError when both attempts fail', async () => {
    const fetcher: typeof fetch = async () => mockResponse(403);
    await expect(fetchAttachment('https://x.test/img.jpg', 'pit', fetcher)).rejects.toBeInstanceOf(
      AttachmentFetchError,
    );
  });

  it('throws AttachmentFetchError on 404 without retry', async () => {
    let calls = 0;
    const fetcher: typeof fetch = async () => {
      calls++;
      return mockResponse(404);
    };
    await expect(fetchAttachment('https://x.test/img.jpg', 'pit', fetcher)).rejects.toBeInstanceOf(
      AttachmentFetchError,
    );
    expect(calls).toBe(1);
  });

  it('throws ImageTooLargeError when Content-Length exceeds cap', async () => {
    const fetcher: typeof fetch = async () =>
      mockResponse(200, new Uint8Array(0), { 'content-length': String(6 * 1024 * 1024) });
    await expect(fetchAttachment('https://x.test/big.jpg', 'pit', fetcher)).rejects.toBeInstanceOf(
      ImageTooLargeError,
    );
  });

  it('throws ImageTooLargeError when actual buffer exceeds cap even if Content-Length is small/missing', async () => {
    const huge = new Uint8Array(6 * 1024 * 1024 + 1);
    const fetcher: typeof fetch = async () => mockResponse(200, huge);
    await expect(fetchAttachment('https://x.test/big.jpg', 'pit', fetcher)).rejects.toBeInstanceOf(
      ImageTooLargeError,
    );
  });
});
