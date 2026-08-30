import type { Db } from '../db/kysely.js';
import type { GhlClient } from '../ghl/client.js';
import type { Salon, Conversation } from './types.js';
import * as escalationsRepo from '../db/repos/escalations.js';
import * as conversationsRepo from '../db/repos/conversations.js';
import * as eventsRepo from '../db/repos/events.js';
import * as salonsRepo from '../db/repos/salons.js';
import { GhlApiError } from '../ghl/errors.js';
import { escalationLabel } from './escalation-labels.js';
import { logger } from '../lib/logger.js';

/**
 * Reasons that reach the owner WITHOUT stopping the bot.
 *
 * The distinction is whether a human has to take the conversation over. Media the
 * bot cannot open, and a lead she will want to see, both need her attention while
 * the bot keeps the client warm. A refund or a complaint needs her instead of the
 * bot, so it pauses.
 *
 * Deciding this from the reason rather than from the caller is what makes a lead
 * routable at all. Until 2026-08-26 `pauseBot: false` existed only inside
 * handle-inbound, chosen from the attachment type, so a damage photo (an ordinary
 * image) had no path to the owner whatsoever. It got a good consult reply, no
 * notification fired, and the color-correction lead died in the inbox. Round 4
 * called that the highest-priority failure in the run, and it was lost revenue
 * rather than a bug the client could see.
 */
export const NOTIFY_WITHOUT_PAUSING = new Set([
  'video_attachment',
  'audio_attachment',
  'unviewable_media',
  'unconfirmed_media_attachment',
  'image_without_url',
  'correction_lead',
]);

export interface EscalateInput {
  db: Db;
  ghl: GhlClient;
  salon: Salon;
  conversation: Conversation;
  reason: string;
  contextSummary?: string;
  /**
   * Whether this also hands the conversation over, i.e. stops the bot until the
   * owner is done. Defaults to whatever the reason implies, which is what callers
   * should normally rely on. Pass it explicitly only to override that.
   *
   * Media is the exception (QA Round 3, item 4.6): a client sending a video or a
   * voice note should get the owner's attention AND keep talking to the bot.
   * Freezing that conversation for hours over an attachment costs a lead, and it
   * made the tag dishonest — it claimed the bot was paused while the bot replied.
   */
  pauseBot?: boolean;
}

export async function escalateToOwner(input: EscalateInput): Promise<void> {
  const pauseBot = input.pauseBot ?? !NOTIFY_WITHOUT_PAUSING.has(input.reason);
  const handoffUntil = new Date(Date.now() + input.salon.config.handoff_window_hours * 3600_000);

  await input.db.transaction().execute(async (tx) => {
    // A notify-only alert deliberately writes NO escalations row. That table
    // drives auto-resume, which finds rows whose conversation handoff has
    // expired — with no handoff there is nothing to expire, so the row would sit
    // active forever and never release its tag. The event carries the record.
    if (pauseBot) {
      await escalationsRepo.upsertActive(tx, input.conversation.id, input.reason, input.contextSummary ?? null);
      await conversationsRepo.setHandoffUntil(tx, input.conversation.id, handoffUntil);
    }
    await eventsRepo.insert(tx, input.conversation.id, 'escalated_to_owner', {
      reason: input.reason,
      ...(pauseBot ? {} : { notifyOnly: true }),
    });
  });

  // `escalation_active` means exactly one thing: the bot is paused. A notify-only
  // alert must NOT set it, for a reason that only shows up two turns later — the
  // owner's notification workflow triggers on "tag added", and a tag that is
  // already present cannot be added again. A media alert that left the tag stuck
  // would silently swallow the notification for the NEXT real escalation, so a
  // refund or a medical question would pause the bot for 12 hours with nobody
  // told. Notify-only carries its own tag instead.
  const tag = pauseBot ? 'escalation_active' : 'owner_fyi';

  // The reason is written BEFORE the tag, and the order is the whole point.
  //
  // The owner's notification workflow triggers on "tag added" and reads
  // last_escalation_reason to fill in its Reason line. Writing the field after the
  // tag meant the workflow read whatever the PREVIOUS escalation had left there.
  // On 2026-08-26 a VIP feature offer from a 300k-follower account was announced
  // to the owner as "Refund request", because a refund had escalated on the same
  // contact minutes earlier. It is a race, so it also passed sometimes, which is
  // why the wrong reasons looked like a per-branch bug rather than one ordering
  // mistake. Nothing downstream is allowed to move above this.
  try {
    await input.ghl.updateCustomField({
      contactId: input.conversation.ghlContactId,
      fieldId: input.salon.config.ghl_custom_field_ids.last_escalation_reason,
      // The owner reads this field in a notification, so it carries the human
      // label. The raw code stays in escalations.reason and the event payload.
      value: escalationLabel(input.reason),
    });
  } catch (err) {
    if (err instanceof GhlApiError && (err.status === 401 || err.status === 403)) {
      logger.error({ err, salonId: input.salon.id }, 'GHL auth failed during updateCustomField; disabling salon');
      await salonsRepo.setActive(input.db, input.salon.id, false);
    } else {
      logger.error({ err, conversationId: input.conversation.id }, 'ghl updateCustomField failed during escalate');
    }
  }

  // Now the tag, which is what actually notifies.
  try {
    // Remove first so the add always registers as a transition, even if a
    // previous cycle left the tag behind. GHL fires its workflow on the add.
    await input.ghl.removeTag(input.conversation.ghlContactId, [tag]).catch(() => undefined);
    await input.ghl.addTag(input.conversation.ghlContactId, [tag]);
  } catch (err) {
    if (err instanceof GhlApiError && (err.status === 401 || err.status === 403)) {
      logger.error({ err, salonId: input.salon.id }, 'GHL auth failed during addTag; disabling salon');
      await salonsRepo.setActive(input.db, input.salon.id, false);
    } else {
      logger.error({ err, conversationId: input.conversation.id }, 'ghl addTag failed during escalate');
    }
  }

  logger.info(
    {
      conversationId: input.conversation.id,
      reason: input.reason,
      handoffUntil: pauseBot ? handoffUntil : null,
      pauseBot,
    },
    pauseBot ? 'escalated to owner' : 'notified owner without pausing the bot',
  );
}
