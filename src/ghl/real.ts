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

    const res = await this.fetcher(`${GHL_BASE_URL}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      if (isOutsideWindowError(res.status, text)) {
        throw new OutsideMessagingWindowError(path, text);
      }
      throw new GhlApiError(res.status, path, text);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
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
