import Anthropic from '@anthropic-ai/sdk';

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface LlmCompleteInput {
  systemPrompt: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  tools: ToolDefinition[];
  model: string;
  maxTokens: number;
}

export interface LlmCompleteOutput {
  text: string;
  toolCalls: ToolCall[];
  usage: { inputTokens: number; outputTokens: number };
}

export interface LlmClient {
  complete(input: LlmCompleteInput): Promise<LlmCompleteOutput>;
}

/** Korak 1 stub. Replaced with AnthropicLlmClient in Korak 4. */
export class StubLlmClient implements LlmClient {
  async complete(_input: LlmCompleteInput): Promise<LlmCompleteOutput> {
    return {
      text: 'Hey hun! How can I help?',
      toolCalls: [],
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }
}

export class AnthropicLlmClient implements LlmClient {
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey, timeout: 30_000, maxRetries: 2 });
  }

  async complete(input: LlmCompleteInput): Promise<LlmCompleteOutput> {
    const response = await this.client.messages.create({
      model: input.model,
      max_tokens: input.maxTokens,
      system: input.systemPrompt,
      messages: input.messages.map((m) => ({ role: m.role, content: m.content })),
      tools: input.tools.length > 0
        ? input.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema as Anthropic.Tool.InputSchema }))
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
