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

    // GHL merge tags can render to the literal strings "null" / "undefined" / ""
    // when the template field has no value for the trigger context. Normalize
    // these to real null so downstream dedup and getMessage logic doesn't treat
    // them as opaque IDs.
    const norm = (s: string | null | undefined): string | null =>
      !s || s === 'null' || s === 'undefined' ? null : s;

    setImmediate(async () => {
      try {
        await handleInbound(
          {
            db: app.deps.db,
            ghlFor: app.deps.ghlFor,
            llm: app.deps.llm,
            defaultLlmModel: app.deps.defaultLlmModel,
            respondQueue: app.deps.respondQueue,
          },
          {
            locationId: parsed.data.location_id,
            contactId: parsed.data.contact_id,
            contactHandle: norm(parsed.data.contact_handle),
            messageId: norm(parsed.data.message_id),
            messageText: norm(parsed.data.message_text),
            rawPayload: parsed.data,
          },
        );
      } catch (err) {
        logger.error({ err }, 'handle-inbound failed');
      }
    });
  });
}
