import { GoogleGenAI } from '@google/genai';
import type { LlmClient, LlmCompleteInput, LlmCompleteOutput, ToolCall } from './client.js';

export class GeminiLlmClient implements LlmClient {
  private ai: GoogleGenAI;

  constructor(apiKey: string) {
    this.ai = new GoogleGenAI({ apiKey });
  }

  async complete(input: LlmCompleteInput): Promise<LlmCompleteOutput> {
    // Map our role-based messages to Gemini's contents shape.
    // Anthropic/OpenAI use 'assistant'; Gemini uses 'model'.
    const contents = input.messages.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

    const tools =
      input.tools.length > 0
        ? [
            {
              functionDeclarations: input.tools.map((t) => ({
                name: t.name,
                description: t.description,
                parametersJsonSchema: t.input_schema,
              })),
            },
          ]
        : undefined;

    const response = await this.ai.models.generateContent({
      model: input.model,
      contents,
      config: {
        systemInstruction: input.systemPrompt,
        maxOutputTokens: input.maxTokens,
        tools,
      },
    });

    const candidate = response.candidates?.[0];
    let text = '';
    const toolCalls: ToolCall[] = [];

    for (const part of candidate?.content?.parts ?? []) {
      if (typeof part.text === 'string') text += part.text;
      if (part.functionCall) {
        toolCalls.push({
          id: part.functionCall.id ?? `gemini_${toolCalls.length}`,
          name: part.functionCall.name ?? 'unknown',
          arguments: (part.functionCall.args as Record<string, unknown>) ?? {},
        });
      }
    }

    const usage = response.usageMetadata;
    return {
      text,
      toolCalls,
      usage: {
        inputTokens: usage?.promptTokenCount ?? 0,
        outputTokens: usage?.candidatesTokenCount ?? 0,
      },
    };
  }
}
