import { describe, it, expect } from 'vitest';
import { RealGhlClient } from '../../../src/ghl/real.js';
import { GhlApiError, OutsideMessagingWindowError } from '../../../src/ghl/errors.js';

function mockFetcher(impl: typeof fetch): typeof fetch {
  return impl;
}

describe('RealGhlClient.request', () => {
  it('sends Authorization and Version headers on every call', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetcher = mockFetcher(async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const client = new RealGhlClient('pit-abc', 'loc-1', fetcher);
    await client.getMessage('msg-1');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://services.leadconnectorhq.com/conversations/messages/msg-1');
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer pit-abc');
    expect(headers['Version']).toBe('2021-04-15');
  });

  it('throws GhlApiError on non-2xx with status preserved', async () => {
    const fetcher = mockFetcher(async () =>
      new Response('not found', { status: 404 }),
    );
    const client = new RealGhlClient('pit', 'loc', fetcher);
    await expect(client.getMessage('x')).rejects.toMatchObject({
      name: 'GhlApiError',
      status: 404,
    });
  });

  it('throws OutsideMessagingWindowError on 422 with 24-hour body', async () => {
    const fetcher = mockFetcher(async () =>
      new Response('Cannot send outside the 24-hour window', { status: 422 }),
    );
    const client = new RealGhlClient('pit', 'loc', fetcher);
    await expect(
      client.sendMessage({ contactId: 'c1', type: 'IG', message: 'hi' }),
    ).rejects.toBeInstanceOf(OutsideMessagingWindowError);
  });
});
