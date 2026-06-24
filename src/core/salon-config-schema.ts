import { z } from 'zod';

export const SalonConfigSchema = z.object({
  response_delay_ms: z.number().int().positive().default(40_000),
  llm_model: z.string().optional(),
  handoff_window_hours: z.number().positive().default(4),
  booking_link_dedup_window_hours: z.number().int().positive().default(24),
  max_words_per_message: z.number().int().positive().default(40),
  max_emojis: z.number().int().nonnegative().default(2),
  ghl_custom_field_ids: z.object({
    needs_owner_attention: z.string(),
    bot_paused_until: z.string(),
    last_escalation_reason: z.string(),
  }),
  image_processing: z
    .object({
      enabled: z.boolean().default(true),
      max_dimension: z.number().int().min(512).max(2048).default(1280),
      jpeg_quality: z.number().int().min(40).max(95).default(80),
    })
    .default({}),
});

export type SalonConfig = z.infer<typeof SalonConfigSchema>;
