import type { AppConfig } from '../config.js';
import type { LlmClient } from './client.js';
import { AnthropicLlmClient } from './anthropic.js';
import { OpenAiLlmClient } from './openai.js';
import { GeminiLlmClient } from './gemini.js';

export function createLlmClient(cfg: AppConfig): LlmClient {
  switch (cfg.llmProvider) {
    case 'anthropic':
      if (!cfg.anthropicApiKey) throw new Error('ANTHROPIC_API_KEY required');
      return new AnthropicLlmClient(cfg.anthropicApiKey);
    case 'openai':
      if (!cfg.openaiApiKey) throw new Error('OPENAI_API_KEY required');
      return new OpenAiLlmClient(cfg.openaiApiKey);
    case 'gemini':
      if (!cfg.geminiApiKey) throw new Error('GEMINI_API_KEY required');
      return new GeminiLlmClient(cfg.geminiApiKey);
  }
}
