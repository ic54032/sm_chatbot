import type {
  LlmClient,
  LlmCompleteInput,
  LlmCompleteOutput,
  ToolCall,
} from '../../src/llm/client.js';

export interface StagedResponse {
  match: (input: LlmCompleteInput) => boolean;
  output: {
    text: string;
    /**
     * The vocabulary most specs are written in. When the caller asks for a
     * schema, these are translated into the fields that replaced them, so a test
     * that stages "the model escalated with reason X" keeps asserting that and
     * does not have to care which channel carried it.
     */
    toolCalls?: ToolCall[];
    /** Stage the object directly when the point of the test IS its shape. */
    parsed?: unknown;
  };
}

export class FakeLlmClient implements LlmClient {
  private staged: StagedResponse[] = [];
  public calls: LlmCompleteInput[] = [];

  stage(response: StagedResponse): void {
    this.staged.push(response);
  }

  reset(): void {
    this.staged = [];
    this.calls = [];
  }

  async complete(input: LlmCompleteInput): Promise<LlmCompleteOutput> {
    this.calls.push(input);
    const matched = this.staged.find((s) => s.match(input));
    if (!matched) {
      throw new Error(
        `FakeLlmClient: no staged response matched. Last user message: ${JSON.stringify(input.messages.at(-1))}`,
      );
    }
    const usage = { inputTokens: 100, outputTokens: 50 };

    if (!input.responseSchema) {
      return { text: matched.output.text, toolCalls: matched.output.toolCalls ?? [], usage };
    }

    const parsed = matched.output.parsed ?? toReplyObject(matched.output);
    // Faithful to the real client, which returns the raw JSON as `text`. Anything
    // reading ai_raw_output therefore sees what production stores.
    return { text: JSON.stringify(parsed), toolCalls: [], parsed, usage };
  }
}

function toReplyObject(output: StagedResponse['output']): Record<string, unknown> {
  const calls = output.toolCalls ?? [];
  const escalate = calls.find((c) => c.name === 'escalate_to_owner');
  const flag = calls.find((c) => c.name === 'set_state_flag');
  return {
    reply: output.text,
    escalation_reason: escalate ? (escalate.arguments.reason ?? null) : null,
    escalation_context: escalate ? (escalate.arguments.context_summary ?? null) : null,
    state_flag_key: flag ? (flag.arguments.key ?? null) : null,
    state_flag_value: flag ? (flag.arguments.value ?? null) : null,
  };
}
