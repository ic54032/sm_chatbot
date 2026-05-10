import type {
  LlmClient,
  LlmCompleteInput,
  LlmCompleteOutput,
  ToolCall,
} from '../../src/llm/client.js';

export interface StagedResponse {
  match: (input: LlmCompleteInput) => boolean;
  output: { text: string; toolCalls?: ToolCall[] };
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
    return {
      text: matched.output.text,
      toolCalls: matched.output.toolCalls ?? [],
      usage: { inputTokens: 100, outputTokens: 50 },
    };
  }
}
