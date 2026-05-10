import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { logger } from '../lib/logger.js';
import { handleInbound } from '../core/handle-inbound.js';

const DevPayloadSchema = z.object({
  location_id: z.string().default('loc_dev'),
  contact_id: z.string().default('contact_dev'),
  contact_handle: z.string().optional(),
  message_id: z.string().optional(),
  message_text: z.string().min(1),
  stage_get_message: z.boolean().default(false),
});

export async function devSimulateRoute(app: FastifyInstance): Promise<void> {
  if (app.deps.cfg.nodeEnv === 'production') {
    return;
  }

  app.post('/dev/simulate-inbound', async (request, reply) => {
    const parsed = DevPayloadSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_payload', details: parsed.error.flatten() });
    }

    const data = parsed.data;
    const messageId = data.message_id ?? `dev_msg_${Date.now()}`;

    if (data.stage_get_message) {
      app.deps.ghl.stageMessage(messageId, data.message_text);
    }

    reply.code(202).send({ accepted: true, message_id: messageId });

    setImmediate(async () => {
      try {
        await handleInbound(
          { db: app.deps.db, ghl: app.deps.ghl, llm: app.deps.llm },
          {
            locationId: data.location_id,
            contactId: data.contact_id,
            contactHandle: data.contact_handle ?? null,
            messageId,
            messageText: data.stage_get_message ? null : data.message_text,
            rawPayload: data,
          },
        );
      } catch (err) {
        logger.error({ err }, 'dev simulate handle-inbound failed');
      }
    });
  });
}
