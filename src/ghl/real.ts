import type { GhlClient } from './client.js';
import { GhlApiError, OutsideMessagingWindowError, isOutsideWindowError } from './errors.js';

const GHL_BASE_URL = 'https://services.leadconnectorhq.com';
const GHL_API_VERSION = '2021-04-15';
const REQUEST_TIMEOUT_MS = 15_000;

type Fetcher = typeof fetch;

export class RealGhlClient implements GhlClient {
  private readonly fetcher: Fetcher;
  constructor(
    private readonly pit: string,
    private readonly locationId: string,
    fetcher?: Fetcher,
  ) {
    this.fetcher = fetcher ?? fetch;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.pit}`,
      Version: GHL_API_VERSION,
      Accept: 'application/json',
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const backoffMs = [500, 1500]; // up to 2 retries for 5xx
    let retried429 = false;

    for (let attempt = 0; attempt <= backoffMs.length; attempt++) {
      const res = await this.fetcher(`${GHL_BASE_URL}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (res.ok) {
        if (res.status === 204) return undefined as T;
        return (await res.json()) as T;
      }

      const text = await res.text().catch(() => '');

      if (isOutsideWindowError(res.status, text)) {
        throw new OutsideMessagingWindowError(path, text);
      }

      // 429: retry once respecting Retry-After
      if (res.status === 429 && !retried429) {
        retried429 = true;
        const retryAfter = parseInt(res.headers.get('Retry-After') ?? '1', 10);
        await sleep(Math.max(0, retryAfter * 1000));
        continue;
      }

      // 5xx: retry with backoff
      if (res.status >= 500 && attempt < backoffMs.length) {
        await sleep(backoffMs[attempt]);
        continue;
      }

      throw new GhlApiError(res.status, path, text);
    }

    // Loop exhausted without returning or throwing — should be unreachable but
    // throw a sensible error to satisfy TS narrowing.
    throw new GhlApiError(500, path, 'retry loop exhausted');
  }

  async sendMessage(input: { contactId: string; type: 'IG'; message: string }): Promise<{ ghlMessageId: string }> {
    const res = await this.request<{ messageId?: string; id?: string }>('POST', '/conversations/messages', {
      type: input.type,
      contactId: input.contactId,
      message: input.message,
      locationId: this.locationId,
    });
    const id = res.messageId ?? res.id;
    if (!id) throw new GhlApiError(500, '/conversations/messages', 'response missing messageId/id');
    return { ghlMessageId: id };
  }

  async getMessage(messageId: string): Promise<{ text: string; attachments: Array<{ url: string; type: 'image' | 'audio' | 'video' }> }> {
    const res = await this.request<{ message?: { body?: string; attachments?: Array<{ url: string; type: string }> } }>(
      'GET',
      `/conversations/messages/${encodeURIComponent(messageId)}`,
    );
    const msg = res.message ?? {};
    return {
      text: msg.body ?? '',
      attachments: (msg.attachments ?? []).map((a) => ({
        url: a.url,
        type: (a.type as 'image' | 'audio' | 'video') ?? 'image',
      })),
    };
  }

  async addTag(contactId: string, tags: string[]): Promise<void> {
    await this.request<unknown>('POST', `/contacts/${encodeURIComponent(contactId)}/tags`, { tags });
  }

  async removeTag(contactId: string, tags: string[]): Promise<void> {
    await this.request<unknown>('DELETE', `/contacts/${encodeURIComponent(contactId)}/tags`, { tags });
  }

  async updateCustomField(input: { contactId: string; fieldId: string; value: string | number | boolean }): Promise<void> {
    await this.request<unknown>('PUT', `/contacts/${encodeURIComponent(input.contactId)}`, {
      customFields: [{ id: input.fieldId, value: input.value }],
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
