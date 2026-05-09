import { z } from 'zod';

export const SotSchema = z.object({
  salon: z.object({
    name: z.string(),
    owner_first_name: z.string(),
    location: z.string(),
    timezone: z.string(),
    hours: z.record(z.string(), z.string()),
    booking_link: z.string().url(),
    phone: z.string().optional(),
  }),
  stylists: z.array(z.object({
    name: z.string(),
    specialties: z.array(z.string()),
  })),
  services: z.array(z.object({
    name: z.string(),
    price_range: z.object({
      min: z.number(),
      max: z.number(),
      currency: z.string(),
    }).optional(),
    duration_minutes: z.number().optional(),
    requires_consultation: z.boolean().default(false),
    notes: z.string().optional(),
  })),
  policies: z.object({
    cancellation: z.string().optional(),
    deposit: z.string().optional(),
    price_quote_policy: z.string().optional(),
  }).default({}),
  voice: z.object({
    tone_notes: z.string(),
    signature_phrases: z.array(z.string()).default([]),
    avoid: z.array(z.string()).default([]),
  }),
  escalation_triggers: z.array(z.string()).default([]),
  faqs: z.array(z.object({ q: z.string(), a: z.string() })).default([]),
});

export type Sot = z.infer<typeof SotSchema>;
