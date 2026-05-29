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
  })
  .passthrough();

export type Sot = z.infer<typeof SotSchema>;
