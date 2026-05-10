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
    llmModel: z.string().default('gemini-2.5-flash'),
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
  });
}
