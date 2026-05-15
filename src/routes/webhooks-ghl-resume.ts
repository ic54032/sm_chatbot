import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as salonsRepo from '../db/repos/salons.js';
import * as conversationsRepo from '../db/repos/conversations.js';
import * as escalationsRepo from '../db/repos/escalations.js';
import * as eventsRepo from '../db/repos/events.js';
import { logger } from '../lib/logger.js';

const ResumePayloadSchema = z.object({
  location_id: z.string(),
  contact_id: z.string(),
});

export async function resumeWebhookRoute(app: FastifyInstance): Promise<void> {
  app.post('/webhooks/ghl/resume', async (request, reply) => {
    const secret = request.headers['x-webhook-secret'];
    if (secret !== app.deps.cfg.webhookSecret) {
      logger.warn('resume: webhook secret mismatch');
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const parsed = ResumePayloadSchema.safeParse(request.body);
    if (!parsed.success) {
      logger.warn({ details: parsed.error.flatten() }, 'resume: invalid payload');
      return reply.code(400).send({ error: 'invalid_payload' });
    }
    reply.code(200).send({ accepted: true });

    setImmediate(async () => {
      try {
        const salon = await salonsRepo.findByLocationId(app.deps.db, parsed.data.location_id, app.deps.cfg.pitEncryptionKey);
        if (!salon) {
          logger.warn({ locationId: parsed.data.location_id }, 'resume: salon not found');
          return;
        }
        const conv = await app.deps.db
          .selectFrom('conversations')
          .where('salon_id', '=', salon.id)
          .where('ghl_contact_id', '=', parsed.data.contact_id)
          .select(['id'])
          .executeTakeFirst();
        if (!conv) {
          logger.warn({ contactId: parsed.data.contact_id }, 'resume: conversation not found');
          return;
        }
        const updated = await app.deps.db.transaction().execute(async (tx) => {
          await conversationsRepo.setHandoffUntil(tx, conv.id, null);
          const rowsMarked = await escalationsRepo.markResumedByConversation(tx, conv.id, 'owner_manual');
          if (rowsMarked > 0) {
            await eventsRepo.insert(tx, conv.id, 'bot_resumed', { by: 'owner_manual' });
          }
          return rowsMarked;
        });
        if (updated > 0) {
          logger.info({ conversationId: conv.id }, 'manual resume completed');
        } else {
          logger.info({ conversationId: conv.id }, 'manual resume webhook fired but no active escalation; no-op');
        }
      } catch (err) {
        logger.error({ err }, 'resume webhook handler failed');
      }
    });
  });
}
