import { describe, it, expect, vi } from 'vitest';
import { GeminiLlmClient } from '../../../src/llm/gemini.js';

function makeClient(): { client: GeminiLlmClient; gen: ReturnType<typeof vi.fn> } {
  const client = new GeminiLlmClient('test-key');
  const gen = vi.fn(async () => ({
    candidates: [{ content: { parts: [{ text: 'ok' }] } }],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
  }));
  // @ts-expect-error — swap SDK
  client.ai = { models: { generateContent: gen } };
  return { client, gen };
}

describe('GeminiLlmClient mapping', () => {
  it('passes string content as single text part', async () => {
    const { client, gen } = makeClient();
    await client.complete({
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      model: 'gemini-2.0-flash',
      maxTokens: 100,
    });
    const arg = gen.mock.calls[0][0] as { contents: Array<{ role: string; parts: unknown }> };
    expect(arg.contents[0]).toEqual({ role: 'user', parts: [{ text: 'hello' }] });
  });

  it('maps ContentBlock[] with image+text to Gemini parts', async () => {
    const { client, gen } = makeClient();
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
      model: 'gemini-2.0-flash',
      maxTokens: 100,
    });
    const arg = gen.mock.calls[0][0] as { contents: Array<{ role: string; parts: unknown }> };
    expect(arg.contents[0]).toEqual({
      role: 'user',
      parts: [
        { inlineData: { mimeType: 'image/jpeg', data: 'AAAA' } },
        { text: 'check this' },
      ],
    });
  });

  it("maps role 'assistant' to 'model'", async () => {
    const { client, gen } = makeClient();
    await client.complete({
      systemPrompt: 'sys',
      messages: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: 'a' },
      ],
      tools: [],
      model: 'gemini-2.0-flash',
      maxTokens: 100,
    });
    const arg = gen.mock.calls[0][0] as { contents: Array<{ role: string }> };
    expect(arg.contents[1].role).toBe('model');
  });
});
