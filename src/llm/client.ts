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

/**
 * A JSON Schema the provider must constrain its output to. `schema` is passed
 * through verbatim, so it has to satisfy whatever the provider demands of it —
 * for OpenAI strict mode that means additionalProperties false everywhere, every
 * property listed in required, and optionality expressed as nullability.
 */
export interface ResponseSchema {
  name: string;
  schema: Record<string, unknown>;
}

export interface LlmCompleteInput {
  systemPrompt: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string | ContentBlock[] }>;
  tools: ToolDefinition[];
  model: string;
  maxTokens: number;
  /**
   * When set, the reply comes back as JSON matching this schema and `tools` is
   * ignored. A provider that cannot honour it MUST throw rather than fall back to
   * prose: silently returning unstructured text would strand the caller with a
   * response it has no way to read, which is worse than failing the turn.
   */
  responseSchema?: ResponseSchema;
}

export interface LlmCompleteOutput {
  text: string;
  toolCalls: ToolCall[];
  usage: { inputTokens: number; outputTokens: number };
  /**
   * The parsed object, set only when `responseSchema` was requested. Typed as
   * unknown because this layer knows nothing about the domain — the caller
   * validates it against the same schema it asked for.
   */
  parsed?: unknown;
}

export interface LlmClient {
  complete(input: LlmCompleteInput): Promise<LlmCompleteOutput>;
}

/** Korak 1 stub. Replaced with provider-specific clients in Korak 4. Kept for reference. */
export class StubLlmClient implements LlmClient {
  async complete(input: LlmCompleteInput): Promise<LlmCompleteOutput> {
    if (input.responseSchema) throw new Error('StubLlmClient does not implement structured output');
    return {
      text: 'Hey hun! How can I help?',
      toolCalls: [],
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }
}
