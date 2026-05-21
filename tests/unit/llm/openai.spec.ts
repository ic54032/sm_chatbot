import { describe, it, expect, vi } from 'vitest';
import { OpenAiLlmClient } from '../../../src/llm/openai.js';

function makeClient(): { client: OpenAiLlmClient; create: ReturnType<typeof vi.fn> } {
  const client = new OpenAiLlmClient('test-key');
  const create = vi.fn(async () => ({
    choices: [{ message: { content: 'ok', tool_calls: [] } }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  }));
  // @ts-expect-error — swap SDK
  client.client = { chat: { completions: { create } } };
  return { client, create };
}

describe('OpenAiLlmClient mapping', () => {
  it('passes string content through unchanged', async () => {
    const { client, create } = makeClient();
    await client.complete({
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      model: 'gpt-4o',
      maxTokens: 100,
    });
    const arg = create.mock.calls[0][0] as { messages: Array<{ role: string; content: unknown }> };
    expect(arg.messages[0]).toEqual({ role: 'system', content: 'sys' });
    expect(arg.messages[1]).toEqual({ role: 'user', content: 'hello' });
  });

  it('maps ContentBlock[] with image+text to OpenAI multipart format', async () => {
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
      model: 'gpt-4o',
      maxTokens: 100,
    });
    const arg = create.mock.calls[0][0] as { messages: Array<{ role: string; content: unknown }> };
    expect(arg.messages[1]).toEqual({
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } },
        { type: 'text', text: 'check this' },
      ],
    });
  });
});
