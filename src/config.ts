import 'dotenv/config';
import { z } from 'zod';

const ConfigSchema = z
  .object({
    port: z.coerce.number().int().positive().default(3000),
    nodeEnv: z.enum(['development', 'test', 'production']).default('development'),
    logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    databaseUrl: z.string().url(),
    redisUrl: z.string().url(),
    webhookSecret: z.string().min(8),
    adminApiKey: z.string().min(8),
    llmProvider: z.enum(['gemini', 'openai', 'anthropic']).default('gemini'),
    anthropicApiKey: z.string().min(1).optional(),
    openaiApiKey: z.string().min(1).optional(),
    geminiApiKey: z.string().min(1).optional(),
    llmModel: z.string().default('gpt-4o'),
    useMockGhl: z
      .string()
      .optional()
      .default('false')
      .transform((v) => v === 'true' || v === '1'),
    ghlApiBaseUrl: z.string().url().default('https://services.leadconnectorhq.com'),
    ghlApiVersion: z.string().default('2021-04-15'),
    // Accepts 43 (base64url no padding), 44 (base64 with padding), or 45 chars.
    // Empty string from unset env is coerced to undefined. crypto.ts:parseKey
    // does the authoritative validation (decoded bytes === 32) when actually used.
    pitEncryptionKey: z
      .string()
      .optional()
      .transform((v) => (v && v.trim() !== '' ? v : undefined))
      .pipe(z.string().min(43).max(45).optional()),
  })
  .superRefine((cfg, ctx) => {
    const requiredKey = {
      anthropic: cfg.anthropicApiKey,
      openai: cfg.openaiApiKey,
      gemini: cfg.geminiApiKey,
    }[cfg.llmProvider];
    if (!requiredKey) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Missing API key for provider "${cfg.llmProvider}". Set ${cfg.llmProvider.toUpperCase()}_API_KEY in .env`,
        path: [`${cfg.llmProvider}ApiKey`],
      });
    }
  });

export type AppConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(): AppConfig {
  return ConfigSchema.parse({
    port: process.env.PORT,
    nodeEnv: process.env.NODE_ENV,
    logLevel: process.env.LOG_LEVEL,
    databaseUrl: process.env.DATABASE_URL,
    redisUrl: process.env.REDIS_URL,
    webhookSecret: process.env.WEBHOOK_SECRET,
    adminApiKey: process.env.ADMIN_API_KEY,
    llmProvider: process.env.LLM_PROVIDER,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    openaiApiKey: process.env.OPENAI_API_KEY,
    geminiApiKey: process.env.GEMINI_API_KEY,
    llmModel: process.env.LLM_MODEL,
    useMockGhl: process.env.USE_MOCK_GHL,
    ghlApiBaseUrl: process.env.GHL_API_BASE_URL,
    ghlApiVersion: process.env.GHL_API_VERSION,
    pitEncryptionKey: process.env.PIT_ENCRYPTION_KEY,
  });
}
