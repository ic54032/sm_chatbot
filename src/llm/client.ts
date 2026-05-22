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

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: 'image/jpeg' | 'image/png' | 'image/webp'; base64: string };

export interface LlmCompleteInput {
  systemPrompt: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string | ContentBlock[] }>;
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

/** Korak 1 stub. Replaced with provider-specific clients in Korak 4. Kept for reference. */
export class StubLlmClient implements LlmClient {
  async complete(_input: LlmCompleteInput): Promise<LlmCompleteOutput> {
    return {
      text: 'Hey hun! How can I help?',
      toolCalls: [],
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }
}
