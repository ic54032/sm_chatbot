import { z } from 'zod';

export const SotSchema = z
  .object({
    salon_basics: z
      .object({
        owner_first_name: z.string().min(1),
        salon_name: z.string().min(1),
      })
      .passthrough(),
    booking: z
      .object({
        url: z.string().url(),
      })
      .passthrough(),
    price_quoting_policy: z.enum(['a', 'b', 'c']),
    // Optional: services the salon explicitly does not offer ("nails", "perms").
    // The master prompt answers these with a warm no instead of escalating.
    service_menu: z
      .object({
        not_offered: z.array(z.string()).default([]),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type Sot = z.infer<typeof SotSchema>;
