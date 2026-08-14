import type { Queue } from 'bullmq';
import type { Db } from '../db/kysely.js';
import type { GhlFactory } from '../ghl/client.js';
import type { LlmClient } from '../llm/client.js';
import * as salonsRepo from '../db/repos/salons.js';
import * as conversationsRepo from '../db/repos/conversations.js';
import * as messagesRepo from '../db/repos/messages.js';
import type { RespondJobData } from '../queue/index.js';
import { logger } from '../lib/logger.js';
import { escalateToOwner } from './escalate.js';
import { parseWebhookAttachments } from '../images/parse-webhook-attachments.js';
import { refineMediaTypes } from '../images/refine-media-type.js';

export interface HandleInboundInput {
  locationId: string;
  contactId: string;
  contactHandle: string | null;
  messageId: string | null;
  messageText: string | null;
  rawPayload: unknown;
}

export interface HandleInboundDeps {
  db: Db;
  ghlFor: GhlFactory;
  llm: LlmClient;
  defaultLlmModel: string;
  respondQueue: Queue<RespondJobData>;
  responseDelayMsOverride?: number;
  encryptionKey?: string;
}

export async function handleInbound(deps: HandleInboundDeps, input: HandleInboundInput): Promise<void> {
  const salon = await salonsRepo.findByLocationId(deps.db, input.locationId, deps.encryptionKey);
  if (!salon) {
    logger.info({ locationId: input.locationId }, 'salon not found for inbound; dropping');
    return;
  }

  const ghl = deps.ghlFor(salon);

  // Two attachment sources, in priority order:
  // (1) Webhook payload's attachments_raw field — comes from {{message.attachments}}
  //     merge tag rendered by the GHL workflow. Available immediately, no API call.
  // (2) ghl.getMessage(messageId) API response — fallback if webhook is bare.
  //     Empirically: GHL stopped exposing {{message.id}} merge tag, so this path
  //     is mostly dead in production. Kept as defensive net for any future where
  //     a different webhook variant carries message_id but not attachments.
  const rawPayloadObj =
    typeof input.rawPayload === 'object' && input.rawPayload !== null
      ? (input.rawPayload as Record<string, unknown>)
      : {};
  const webhookAttachments = parseWebhookAttachments(rawPayloadObj.attachments_raw);
  const fetched = input.messageId
    ? await ghl.getMessage(input.messageId)
    : { text: '', attachments: [] as Array<{ url: string | null; type: 'image' | 'audio' | 'video' }> };
  // Trim to drop whitespace-only inbounds (e.g., accidental empty IG send).
  const textContent = (input.messageText ?? fetched.text ?? '').trim();
  const rawAttachments =
    webhookAttachments.length > 0
      ? webhookAttachments
      : (fetched.attachments ?? []);
  // A voice note and a video are both ".mp4" in the URL, so the extension alone
  // mislabels voice notes as video. Ask the server when it is ambiguous.
  // Attachments without a URL pass through untouched (escalated separately).
  const attachments = await refineMediaTypes(rawAttachments);

  // DIAGNOSTIC: dump full inbound shape so we can see what GHL actually sends.
  // Includes raw payload VALUES (not just keys) so we can spot which merge tags
  // resolved to real strings vs empty/null. Remove once attachment plumbing is
  // verified end-to-end.
  logger.info(
    {
      locationId: input.locationId,
      contactId: input.contactId,
      hasMessageId: !!input.messageId,
      hasMessageText: !!input.messageText,
      webhookTextLen: (input.messageText ?? '').length,
      fetchedTextLen: (fetched.text ?? '').length,
      webhookAttachmentCount: webhookAttachments.length,
      webhookAttachmentTypes: webhookAttachments.map((a) => a.type),
      apiAttachmentCount: (fetched.attachments ?? []).length,
      finalAttachmentCount: attachments.length,
      rawPayloadFull: rawPayloadObj,
    },
    'inbound classification debug',
  );

  const hasVideo = attachments.some((a) => a.type === 'video');
  const hasAudio = attachments.some((a) => a.type === 'audio');
  const images = attachments.filter((a) => a.type === 'image' && a.url);
  const imagesMissingUrl = attachments.filter((a) => a.type === 'image' && !a.url);

  // "Unviewable media": no text and nothing parseable as an attachment, BUT the
  // webhook carried an attachments_raw value — the client sent SOMETHING we can't
  // render (a shared reel, a story reply, a view-once photo, an unsupported type).
  // GHL drops the real content at ingestion: all three merge tags
  // ({{message.body}}, {{message.attachments}}, {{message.subject}}) render empty
  // for these, so there is nothing to answer intelligently. A shared reel is often
  // the highest-intent DM a salon gets ("can you do this look?"), so instead of
  // sitting silent we escalate to the owner and a human picks it up.
  const attachmentsRawValue = rawPayloadObj.attachments_raw;
  const attachmentsRawPresent =
    attachmentsRawValue !== null &&
    attachmentsRawValue !== undefined &&
    (typeof attachmentsRawValue !== 'string' ||
      (attachmentsRawValue.trim() !== '' && attachmentsRawValue.trim() !== 'null'));
  const unviewableMedia = !textContent && attachments.length === 0 && attachmentsRawPresent;

  if (!textContent && attachments.length === 0 && !unviewableMedia) {
    // Truly empty event: no text, no attachments, no attachments_raw. A system
    // ping (receipt / typing / lifecycle), not a client message. Drop silently.
    logger.warn(
      { locationId: input.locationId, contactId: input.contactId },
      'inbound has no text and no attachments; dropping',
    );
    return;
  }

  if (unviewableMedia) {
    logger.warn(
      { locationId: input.locationId, contactId: input.contactId, attachmentsRawValue },
      'inbound is unviewable media (shared reel / story reply / view-once / unsupported); routing to owner escalation',
    );
  }

  const channelType: 'text' | 'image' =
    images.length > 0 || hasVideo || hasAudio || imagesMissingUrl.length > 0 || unviewableMedia
      ? 'image'
      : 'text';

  const conversation = await conversationsRepo.findOrCreate(deps.db, salon.id, input.contactId, input.contactHandle);

  const inserted = await messagesRepo.insertInbound(deps.db, {
    conversationId: conversation.id,
    channelType,
    rawContent: {
      ...(input.rawPayload as Record<string, unknown>),
      attachments, // enriched with fetched attachments — worker reads this back
    },
    textContent: textContent || null,
    ghlMessageId: input.messageId,
  });
  if (!inserted) {
    logger.info({ messageId: input.messageId, contactId: input.contactId }, 'inbound idempotent duplicate; skipping');
    return;
  }

  logger.info(
    { conversationId: conversation.id, channelType, attachmentCount: attachments.length },
    'inbound persisted',
  );

  await conversationsRepo.touchLastMessageAt(deps.db, conversation.id, new Date());

  if (conversation.handoffUntil && conversation.handoffUntil > new Date()) {
    logger.info(
      { conversationId: conversation.id, handoffUntil: conversation.handoffUntil },
      'handoff active; bot paused',
    );
    return;
  }

  // Media the bot cannot read: a video, a voice note, a photo whose URL never
  // arrived, or a shared reel that GHL dropped at ingestion.
  //
  // The owner is notified, but the conversation is NOT frozen (QA Round 3, item
  // 4.6). Pausing on an attachment cost leads and made the tag dishonest — it
  // announced a paused bot while the bot went on replying. The client still gets
  // an answer: the respond job is queued as normal, and the prompt sees a marker
  // describing what arrived, so the model acknowledges it warmly without ever
  // claiming to have seen it.
  const notifyReason = hasVideo
    ? 'video_attachment'
    : hasAudio
      ? 'audio_attachment'
      : imagesMissingUrl.length > 0
        ? 'image_without_url'
        : unviewableMedia
          ? 'unviewable_media'
          : null;

  if (notifyReason) {
    await escalateToOwner({
      db: deps.db,
      ghl,
      salon,
      conversation,
      reason: notifyReason,
      pauseBot: false,
    });
  }

  // Standard put — queue respond job.
  // Rolling-delay coalescing: remove pending job (if any) and schedule fresh.
  // BullMQ semantics: queue.add with same jobId on a delayed/waiting job is a no-op
  // and keeps the existing timer. To reset the timer when a new inbound arrives,
  // we explicitly remove the previous job before adding.
  // jobId separator is `-` not `:` — BullMQ v5 reserves `:` for Redis key namespacing.
  const jobId = `respond-${conversation.id}`;
  const delay = deps.responseDelayMsOverride ?? salon.config.response_delay_ms;

  await deps.respondQueue.remove(jobId).catch(() => undefined);
  await deps.respondQueue.add(
    'respond',
    { conversationId: conversation.id, salonId: salon.id },
    { jobId, delay, removeOnComplete: true, removeOnFail: 10 },
  );

  logger.info({ conversationId: conversation.id, jobId, delayMs: delay }, 'respond job queued');
}
