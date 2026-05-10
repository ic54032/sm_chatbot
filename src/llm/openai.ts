import OpenAI from 'openai';
import type { LlmClient, LlmCompleteInput, LlmCompleteOutput, ToolCall } from './client.js';

export class OpenAiLlmClient implements LlmClient {
  private client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey, timeout: 30_000, maxRetries: 0 });
  }

  async complete(input: LlmCompleteInput): Promise<LlmCompleteOutput> {
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: 'system', content: input.systemPrompt },
      ...input.messages.map(
        (m) => ({ role: m.role, content: m.content }) as OpenAI.Chat.Completions.ChatCompletionMessageParam,
      ),
    ];

    const tools: OpenAI.Chat.Completions.ChatCompletionTool[] | undefined =
      input.tools.length > 0
        ? input.tools.map((t) => ({
            type: 'function' as const,
            function: {
              name: t.name,
              description: t.description,
              parameters: t.input_schema as Record<string, unknown>,
            },
          }))
        : undefined;

    const response = await this.client.chat.completions.create({
      model: input.model,
      messages,
      tools,
      max_tokens: input.maxTokens,
    });

    const choice = response.choices[0];
    const text = choice.message.content ?? '';
    const toolCalls: ToolCall[] = (choice.message.tool_calls ?? []).map((tc) => {
      if (tc.type !== 'function') {
        return { id: tc.id, name: 'unknown', arguments: {} };
      }
      let parsedArgs: Record<string, unknown> = {};
      try {
        parsedArgs = JSON.parse(tc.function.arguments);
      } catch {
        // leave empty
      }
      return {
        id: tc.id,
        name: tc.function.name,
        arguments: parsedArgs,
      };
    });

    return {
      text,
      toolCalls,
      usage: {
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
      },
    };
  }
}
