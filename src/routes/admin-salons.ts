import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as salonsRepo from '../db/repos/salons.js';
import { SotSchema } from '../core/sot-schema.js';
import { SalonConfigSchema } from '../core/salon-config-schema.js';

const CreateSalonBodySchema = z.object({
  display_name: z.string().min(1),
  ghl_location_id: z.string().min(1),
  ghl_pit: z.string().min(1),
  source_of_truth: SotSchema,
  config: SalonConfigSchema,
});

export async function adminSalonsRoute(app: FastifyInstance): Promise<void> {
  app.post('/admin/salons', async (request, reply) => {
    const auth = request.headers['authorization'];
    if (auth !== `Bearer ${app.deps.cfg.adminApiKey}`) {
      return reply.code(401).send({ error: 'unauthorized' });
    }

    const parsed = CreateSalonBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_payload', details: parsed.error.flatten() });
    }

    const salon = await salonsRepo.create(app.deps.db, {
      displayName: parsed.data.display_name,
      ghlLocationId: parsed.data.ghl_location_id,
      ghlPit: parsed.data.ghl_pit,
      sourceOfTruth: parsed.data.source_of_truth,
      config: parsed.data.config,
    });

    return reply.code(201).send({ id: salon.id });
  });
}
