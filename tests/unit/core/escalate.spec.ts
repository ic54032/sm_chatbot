/**
 * escalateToOwner decides two things the owner feels directly: what her
 * notification says, and whether the bot stops talking. Both were wrong in
 * production during QA Round 4, and neither had a test.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GhlClient } from '../../../src/ghl/client.js';
import type { Salon, Conversation } from '../../../src/core/types.js';

vi.mock('../../../src/db/repos/conversations.js', () => ({
  setHandoffUntil: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../src/db/repos/escalations.js', () => ({
  upsertActive: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../src/db/repos/events.js', () => ({
  insert: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../src/db/repos/salons.js', () => ({
  setActive: vi.fn().mockResolvedValue(undefined),
}));

const { escalateToOwner } = await import('../../../src/core/escalate.js');

const fakeSalon = {
  id: 'salon-1',
  displayName: 'Lumen Hair Studio',
  ghlLocationId: 'loc-1',
  ghlPit: 'pit-1',
  isActive: true,
  sourceOfTruth: { salon_basics: { owner_first_name: 'Renata' } },
  config: {
    handoff_window_hours: 12,
    ghl_custom_field_ids: { needs_owner_attention: 'a', bot_paused_until: 'b', last_escalation_reason: 'reason-field' },
  },
} as unknown as Salon;

const fakeConversation = { id: 'conv-1', ghlContactId: 'contact-1' } as unknown as Conversation;

// escalate only needs the transaction to run its callback; every repo inside is mocked.
const makeDb = () => ({ transaction: () => ({ execute: async (cb: (tx: unknown) => unknown) => cb({}) }) }) as never;

function makeGhl(): GhlClient {
  return {
    addTag: vi.fn().mockResolvedValue(undefined),
    removeTag: vi.fn().mockResolvedValue(undefined),
    updateCustomField: vi.fn().mockResolvedValue(undefined),
  } as unknown as GhlClient;
}

const run = (ghl: GhlClient, reason: string, pauseBot?: boolean) =>
  escalateToOwner({ db: makeDb(), ghl, salon: fakeSalon, conversation: fakeConversation, reason, pauseBot });

beforeEach(() => vi.clearAllMocks());

describe('escalateToOwner — the reason reaches GHL before the tag does', () => {
  it('writes last_escalation_reason BEFORE adding the tag', async () => {
    // The owner's workflow triggers on "tag added" and reads that field to fill
    // its Reason line. With the field written afterwards it read the PREVIOUS
    // escalation: on 2026-08-26 a 300k-follower feature offer was announced as
    // "Refund request", because a refund had escalated on the same contact minutes
    // before. Being a race, it also passed sometimes, which is exactly why the
    // wrong reasons looked like a bug in each branch rather than one ordering
    // mistake here.
    const order: string[] = [];
    const ghl = makeGhl();
    vi.mocked(ghl.updateCustomField).mockImplementation(async () => void order.push('field'));
    vi.mocked(ghl.addTag).mockImplementation(async () => void order.push('tag'));

    await run(ghl, 'vip_client');

    expect(order).toEqual(['field', 'tag']);
  });

  it('sends the human label, not the internal code', async () => {
    const ghl = makeGhl();
    await run(ghl, 'vip_client');
    expect(vi.mocked(ghl.updateCustomField)).toHaveBeenCalledWith(
      expect.objectContaining({ fieldId: 'reason-field', value: 'Possible VIP, press or influencer' }),
    );
  });
});

describe('escalateToOwner — pausing follows from the reason', () => {
  it('pauses when a human has to take the conversation over', async () => {
    const ghl = makeGhl();
    await run(ghl, 'refund_request');
    expect(vi.mocked(ghl.addTag)).toHaveBeenCalledWith('contact-1', ['escalation_active']);
  });

  it('notifies without pausing for a lead, so the bot keeps the client warm', async () => {
    // The reason this is decided from the reason at all. Until 2026-08-26 the
    // notify-only path lived inside handle-inbound and was chosen from the
    // attachment type, so a damage photo (an ordinary image) had no route to the
    // owner: it got a good consult reply, nothing fired, and the correction lead
    // died in the inbox. Round 4 called that the costliest failure in the run.
    const ghl = makeGhl();
    await run(ghl, 'correction_lead');
    expect(vi.mocked(ghl.addTag)).toHaveBeenCalledWith('contact-1', ['owner_fyi']);
  });

  it('notifies without pausing for media the bot cannot open', async () => {
    const ghl = makeGhl();
    await run(ghl, 'audio_attachment');
    expect(vi.mocked(ghl.addTag)).toHaveBeenCalledWith('contact-1', ['owner_fyi']);
  });

  it('still honours an explicit pauseBot when a caller passes one', async () => {
    const ghl = makeGhl();
    await run(ghl, 'correction_lead', true);
    expect(vi.mocked(ghl.addTag)).toHaveBeenCalledWith('contact-1', ['escalation_active']);
  });

  it('removes the tag before adding it, so the workflow sees a transition', async () => {
    // A tag that is already present cannot be added again, and the notification
    // fires on the add. Without the remove, a second escalation would be silent.
    const ghl = makeGhl();
    await run(ghl, 'refund_request');
    expect(vi.mocked(ghl.removeTag)).toHaveBeenCalledWith('contact-1', ['escalation_active']);
  });
});
