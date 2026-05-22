import { describe, it, expect, vi } from 'vitest';
import { AnthropicLlmClient } from '../../../src/llm/anthropic.js';

// We can't easily mock the SDK transport, so we test the mapping by stubbing the create method.
function makeClient(): { client: AnthropicLlmClient; create: ReturnType<typeof vi.fn> } {
  const client = new AnthropicLlmClient('test-key');
  const create = vi.fn(async () => ({
    content: [{ type: 'text', text: 'ok' }],
    usage: { input_tokens: 1, output_tokens: 1 },
  }));
  // @ts-expect-error — reach into private to swap SDK
  client.client = { messages: { create } };
  return { client, create };
}

describe('AnthropicLlmClient mapping', () => {
  it('passes string content through unchanged', async () => {
    const { client, create } = makeClient();
    await client.complete({
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      model: 'claude-opus-4-7',
      maxTokens: 100,
    });
    expect(create).toHaveBeenCalledOnce();
    const arg = create.mock.calls[0][0] as { messages: Array<{ role: string; content: unknown }> };
    expect(arg.messages[0]).toEqual({ role: 'user', content: 'hello' });
  });

  it('maps ContentBlock[] with image+text into Anthropic content array', async () => {
    const { client, create } = makeClient();
    await client.complete({
      systemPrompt: 'sys',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', mediaType: 'image/jpeg', base64: 'AAAA' },
            { type: 'text', text: 'check this' },
          ],
        },
      ],
      tools: [],
      model: 'claude-opus-4-7',
      maxTokens: 100,
    });
    const arg = create.mock.calls[0][0] as { messages: Array<{ role: string; content: unknown }> };
    expect(arg.messages[0]).toEqual({
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } },
        { type: 'text', text: 'check this' },
      ],
    });
  });
});
