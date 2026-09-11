import OpenAI from 'openai';
import type { LlmClient, LlmCompleteInput, LlmCompleteOutput, ToolCall, ContentBlock } from './client.js';

export class OpenAiLlmClient implements LlmClient {
  private client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey, timeout: 30_000, maxRetries: 0 });
  }

  async complete(input: LlmCompleteInput): Promise<LlmCompleteOutput> {
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: 'system', content: input.systemPrompt },
      ...input.messages.map((m) => {
        if (typeof m.content === 'string') {
          return { role: m.role, content: m.content } as OpenAI.Chat.Completions.ChatCompletionMessageParam;
        }
        return {
          role: m.role,
          content: m.content.map(mapBlock),
        } as OpenAI.Chat.Completions.ChatCompletionMessageParam;
      }),
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
      max_tokens: input.maxTokens,
      // Structured output and tools are alternatives, never both: the schema IS
      // the whole reply, so leaving tools attached would give the model a second
      // channel and reintroduce exactly the split it exists to remove.
      ...(input.responseSchema
        ? {
            response_format: {
              type: 'json_schema' as const,
              json_schema: {
                name: input.responseSchema.name,
                strict: true,
                schema: input.responseSchema.schema,
              },
            },
          }
        : { tools }),
    });

    const choice = response.choices[0];
    const text = choice.message.content ?? '';

    if (input.responseSchema) {
      // A refusal and a truncation both leave `text` unusable, and both have to be
      // distinguishable in the log from a model that simply answered badly.
      if (choice.message.refusal) {
        throw new Error(`model refused the schema: ${choice.message.refusal}`);
      }
      if (choice.finish_reason === 'length') {
        throw new Error(`structured reply truncated at max_tokens (${input.maxTokens})`);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error(`structured reply was not valid JSON: ${text.slice(0, 200)}`);
      }
      return {
        text,
        toolCalls: [],
        parsed,
        usage: {
          inputTokens: response.usage?.prompt_tokens ?? 0,
          outputTokens: response.usage?.completion_tokens ?? 0,
        },
      };
    }

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

function mapBlock(b: ContentBlock): OpenAI.Chat.Completions.ChatCompletionContentPart {
  if (b.type === 'text') return { type: 'text', text: b.text };
  return {
    type: 'image_url',
    image_url: { url: `data:${b.mediaType};base64,${b.base64}` },
  };
}
