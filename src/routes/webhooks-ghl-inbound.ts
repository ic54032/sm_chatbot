import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { logger } from '../lib/logger.js';
import { handleInbound } from '../core/handle-inbound.js';

const InboundPayloadSchema = z.object({
  location_id: z.string(),
  contact_id: z.string(),
  contact_handle: z.string().optional().nullable(),
  message_id: z.string().optional().nullable(),
  message_text: z.string().optional().nullable(),
  attachments: z.unknown().optional(),
  conversation_id: z.string().optional().nullable(),
  timestamp: z.string().optional().nullable(),
});

export type InboundPayload = z.infer<typeof InboundPayloadSchema>;

export async function inboundWebhookRoute(app: FastifyInstance): Promise<void> {
  app.post('/webhooks/ghl/inbound', async (request, reply) => {
    const secret = request.headers['x-webhook-secret'];
    if (secret !== app.deps.cfg.webhookSecret) {
      logger.warn('webhook secret mismatch');
      return reply.code(401).send({ error: 'unauthorized' });
    }

    const parsed = InboundPayloadSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_payload', details: parsed.error.flatten() });
    }

    reply.code(200).send({ accepted: true });

    setImmediate(async () => {
      try {
        await handleInbound(
          {
            db: app.deps.db,
            ghl: app.deps.ghl,
            llm: app.deps.llm,
            defaultLlmModel: app.deps.defaultLlmModel,
          },
          {
            locationId: parsed.data.location_id,
            contactId: parsed.data.contact_id,
            contactHandle: parsed.data.contact_handle ?? null,
            messageId: parsed.data.message_id ?? null,
            messageText: parsed.data.message_text ?? null,
            rawPayload: parsed.data,
          },
        );
      } catch (err) {
        logger.error({ err }, 'handle-inbound failed');
      }
    });
  });
}
