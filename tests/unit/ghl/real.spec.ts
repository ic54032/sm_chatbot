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

describe('RealGhlClient.sendMessage', () => {
  it('POSTs to /conversations/messages with type=IG, contactId, message, locationId', async () => {
    let captured: { url: string; body: unknown } | undefined;
    const fetcher: typeof fetch = async (url, init) => {
      captured = { url: String(url), body: JSON.parse(init?.body as string) };
      return new Response(JSON.stringify({ messageId: 'm-123' }), { status: 200 });
    };
    const client = new RealGhlClient('pit', 'loc-1', fetcher);
    const result = await client.sendMessage({ contactId: 'c-1', type: 'IG', message: 'Hi' });
    expect(captured?.url).toBe('https://services.leadconnectorhq.com/conversations/messages');
    expect(captured?.body).toEqual({ type: 'IG', contactId: 'c-1', message: 'Hi', locationId: 'loc-1' });
    expect(result.ghlMessageId).toBe('m-123');
  });

  it('falls back to response.id when messageId absent', async () => {
    const fetcher: typeof fetch = async () => new Response(JSON.stringify({ id: 'm-456' }), { status: 200 });
    const client = new RealGhlClient('pit', 'loc', fetcher);
    const result = await client.sendMessage({ contactId: 'c', type: 'IG', message: 'x' });
    expect(result.ghlMessageId).toBe('m-456');
  });

  it('throws GhlApiError when response has neither messageId nor id', async () => {
    const fetcher: typeof fetch = async () => new Response(JSON.stringify({ ok: true }), { status: 200 });
    const client = new RealGhlClient('pit', 'loc', fetcher);
    await expect(client.sendMessage({ contactId: 'c', type: 'IG', message: 'x' })).rejects.toBeInstanceOf(GhlApiError);
  });
});

describe('RealGhlClient.getMessage', () => {
  it('GETs /conversations/messages/{id} and extracts text+attachments', async () => {
    const fetcher: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          message: {
            body: 'hello world',
            attachments: [{ url: 'https://x/img.jpg', type: 'image' }],
          },
        }),
        { status: 200 },
      );
    const client = new RealGhlClient('pit', 'loc', fetcher);
    const result = await client.getMessage('m-9');
    expect(result.text).toBe('hello world');
    expect(result.attachments).toEqual([{ url: 'https://x/img.jpg', type: 'image' }]);
  });

  it('returns empty text+attachments on minimal response', async () => {
    const fetcher: typeof fetch = async () => new Response(JSON.stringify({}), { status: 200 });
    const client = new RealGhlClient('pit', 'loc', fetcher);
    const result = await client.getMessage('m');
    expect(result.text).toBe('');
    expect(result.attachments).toEqual([]);
  });
});

describe('RealGhlClient.addTag', () => {
  it('POSTs to /contacts/{id}/tags with tags array', async () => {
    let captured: { url: string; method?: string; body: unknown } | undefined;
    const fetcher: typeof fetch = async (url, init) => {
      captured = { url: String(url), method: init?.method, body: JSON.parse(init?.body as string) };
      return new Response('{}', { status: 200 });
    };
    const client = new RealGhlClient('pit', 'loc', fetcher);
    await client.addTag('c-1', ['escalation_active']);
    expect(captured?.url).toBe('https://services.leadconnectorhq.com/contacts/c-1/tags');
    expect(captured?.method).toBe('POST');
    expect(captured?.body).toEqual({ tags: ['escalation_active'] });
  });
});

describe('RealGhlClient.removeTag', () => {
  it('DELETEs /contacts/{id}/tags with tags array', async () => {
    let captured: { method?: string; body: unknown } | undefined;
    const fetcher: typeof fetch = async (_url, init) => {
      captured = { method: init?.method, body: JSON.parse(init?.body as string) };
      return new Response('{}', { status: 200 });
    };
    const client = new RealGhlClient('pit', 'loc', fetcher);
    await client.removeTag('c-1', ['escalation_active']);
    expect(captured?.method).toBe('DELETE');
    expect(captured?.body).toEqual({ tags: ['escalation_active'] });
  });
});

describe('RealGhlClient.updateCustomField', () => {
  it('PUTs /contacts/{id} with customFields array', async () => {
    let captured: { url: string; method?: string; body: unknown } | undefined;
    const fetcher: typeof fetch = async (url, init) => {
      captured = { url: String(url), method: init?.method, body: JSON.parse(init?.body as string) };
      return new Response('{}', { status: 200 });
    };
    const client = new RealGhlClient('pit', 'loc', fetcher);
    await client.updateCustomField({ contactId: 'c-1', fieldId: 'f-1', value: 'reason' });
    expect(captured?.url).toBe('https://services.leadconnectorhq.com/contacts/c-1');
    expect(captured?.method).toBe('PUT');
    expect(captured?.body).toEqual({ customFields: [{ id: 'f-1', value: 'reason' }] });
  });
});
