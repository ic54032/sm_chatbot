import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { logger } from '../lib/logger.js';

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

    setImmediate(() => {
      logger.info({ payload: parsed.data }, '[stub] inbound received (handle-inbound wired in Task 8)');
    });
  });
}
