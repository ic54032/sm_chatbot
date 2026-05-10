import Anthropic from '@anthropic-ai/sdk';
import type { LlmClient, LlmCompleteInput, LlmCompleteOutput, ToolCall } from './client.js';

export class AnthropicLlmClient implements LlmClient {
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey, timeout: 30_000, maxRetries: 0 });
  }

  async complete(input: LlmCompleteInput): Promise<LlmCompleteOutput> {
    const response = await this.client.messages.create({
      model: input.model,
      max_tokens: input.maxTokens,
      system: input.systemPrompt,
      messages: input.messages.map((m) => ({ role: m.role, content: m.content })),
      tools:
        input.tools.length > 0
          ? input.tools.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: t.input_schema as Anthropic.Tool.InputSchema,
            }))
          : undefined,
    });

    let text = '';
    const toolCalls: ToolCall[] = [];
    for (const block of response.content) {
      if (block.type === 'text') text += block.text;
      if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          name: block.name,
          arguments: (block.input as Record<string, unknown>) ?? {},
        });
      }
    }

    return {
      text,
      toolCalls,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    };
  }
}
