import 'dotenv/config';
import { z } from 'zod';

const ConfigSchema = z.object({
  port: z.coerce.number().int().positive().default(3000),
  nodeEnv: z.enum(['development', 'test', 'production']).default('development'),
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  databaseUrl: z.string().url(),
  redisUrl: z.string().url(),
  webhookSecret: z.string().min(8),
  adminApiKey: z.string().min(8),
  anthropicApiKey: z.string().min(1),
  llmModel: z.string().default('claude-sonnet-4-5'),
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
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    llmModel: process.env.LLM_MODEL,
  });
}
