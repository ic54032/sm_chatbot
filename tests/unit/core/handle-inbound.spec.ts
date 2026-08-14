/**
 * Unit tests for handleInbound — Task 12: attachment classification + escalation prečaci.
 *
 * Uses vi.mock to avoid a real DB. All repo calls are stubbed; we assert on
 * the side-effects: respondQueue.add calls, escalation reason, absence of client replies.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Queue } from 'bullmq';
import type { GhlClient } from '../../../src/ghl/client.js';
import type { GhlFactory } from '../../../src/ghl/factory.js';
import type { Salon, Conversation } from '../../../src/core/types.js';
import type { LlmClient } from '../../../src/llm/client.js';
import type { RespondJobData } from '../../../src/queue/index.js';

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('../../../src/db/repos/salons.js', () => ({
  findByLocationId: vi.fn(),
  setActive: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/db/repos/conversations.js', () => ({
  findOrCreate: vi.fn(),
  setHandoffUntil: vi.fn().mockResolvedValue(undefined),
  touchLastMessageAt: vi.fn().mockResolvedValue(undefined),
  mergeState: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/db/repos/messages.js', () => ({
  insertInbound: vi.fn(),
  insertOutbound: vi.fn().mockResolvedValue({ id: 'out-1' }),
}));

vi.mock('../../../src/db/repos/events.js', () => ({
  insert: vi.fn().mockResolvedValue(undefined),
  recentBookingLinkSent: vi.fn().mockResolvedValue(false),
}));

vi.mock('../../../src/db/repos/escalations.js', () => ({
  upsertActive: vi.fn().mockResolvedValue(undefined),
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

const fakeSalon: Salon = {
  id: 'salon-1',
  displayName: 'Bella Hair Studio',
  ghlLocationId: 'loc-1',
  ghlPit: 'pit-1',
  isActive: true,
  sourceOfTruth: {
    salon_basics: {
      salon_name: 'Bella Hair Studio',
      owner_first_name: 'Sarah',
    },
    booking: {
      url: 'https://bellahair.example.com/book',
    },
    price_quoting_policy: 'b',
  },
  config: {
    response_delay_ms: 100,
    handoff_window_hours: 4,
    booking_link_dedup_window_hours: 3,
    max_words_per_message: 40,
    max_emojis: 2,
    ghl_custom_field_ids: {
      needs_owner_attention: 'field_attn',
      bot_paused_until: 'field_paused',
      last_escalation_reason: 'field_reason',
    },
    image_processing: { enabled: true, max_dimension: 1280, jpeg_quality: 80 },
  },
};

const fakeConversation: Conversation = {
  id: 'conv-1',
  salonId: 'salon-1',
  ghlContactId: 'contact-1',
  ghlConversationId: null,
  clientHandle: null,
  state: {},
  handoffUntil: null,
  lastMessageAt: null,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a fake Db with a transaction mock so escalateToOwner's tx works. */
function makeFakeDb() {
  return {
    transaction: () => ({
      execute: async (fn: (tx: unknown) => Promise<void>) => {
        await fn({});
      },
    }),
  } as never;
}

/** Build a GhlClient with stubbed methods. Override per-test as needed. */
function makeGhl(overrides: Partial<GhlClient> = {}): GhlClient {
  return {
    sendMessage: vi.fn(async () => ({ ghlMessageId: 'sent-msg-1' })),
    getMessage: vi.fn(async () => ({ text: '', attachments: [] })),
    addTag: vi.fn(async () => undefined),
    removeTag: vi.fn(async () => undefined),
    updateCustomField: vi.fn(async () => undefined),
    ...overrides,
  };
}

function makeRespondQueue() {
  return {
    add: vi.fn(async () => ({ id: 'job-1' })),
    remove: vi.fn(async () => 1),
  } as unknown as Queue<RespondJobData>;
}

function makeLlm(): LlmClient {
  return { complete: vi.fn() } as unknown as LlmClient;
}

function makeDeps(ghl: GhlClient, respondQueue: Queue<RespondJobData>) {
  const ghlFor: GhlFactory = () => ghl;
  return {
    db: makeFakeDb(),
    ghlFor,
    llm: makeLlm(),
    defaultLlmModel: 'fake-model',
    respondQueue,
  };
}

function baseInput(overrides: Partial<{
  locationId: string;
  contactId: string;
  contactHandle: string | null;
  messageId: string | null;
  messageText: string | null;
  rawPayload: unknown;
}> = {}) {
  return {
    locationId: 'loc-1',
    contactId: 'contact-1',
    contactHandle: '@client',
    messageId: 'ghl-msg-1',
    messageText: null,
    rawPayload: {},
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('handleInbound — attachment classification + escalation prečaci', () => {
  let handleInbound: (typeof import('../../../src/core/handle-inbound.js'))['handleInbound'];
  let salonsRepo: typeof import('../../../src/db/repos/salons.js');
  let conversationsRepo: typeof import('../../../src/db/repos/conversations.js');
  let messagesRepo: typeof import('../../../src/db/repos/messages.js');
  let escalationsRepo: typeof import('../../../src/db/repos/escalations.js');
  let eventsRepo: typeof import('../../../src/db/repos/events.js');

  beforeEach(async () => {
    vi.clearAllMocks();
    ({ handleInbound } = await import('../../../src/core/handle-inbound.js'));
    salonsRepo = await import('../../../src/db/repos/salons.js');
    conversationsRepo = await import('../../../src/db/repos/conversations.js');
    messagesRepo = await import('../../../src/db/repos/messages.js');
    escalationsRepo = await import('../../../src/db/repos/escalations.js');
    eventsRepo = await import('../../../src/db/repos/events.js');

    vi.mocked(salonsRepo.findByLocationId).mockResolvedValue(fakeSalon);
    vi.mocked(conversationsRepo.findOrCreate).mockResolvedValue(fakeConversation);
    vi.mocked(messagesRepo.insertInbound).mockResolvedValue({ id: 'msg-1' });
  });

  it('escalates with reason video_attachment when attachment.type=video, notify-only: owner told, bot keeps talking', async () => {
    const ghl = makeGhl({
      getMessage: vi.fn(async () => ({
        text: '',
        attachments: [{ url: 'https://x.test/v.mp4', type: 'video' as const }],
      })),
    });
    const respondQueue = makeRespondQueue();
    const deps = makeDeps(ghl, respondQueue);

    await handleInbound(deps, baseInput());

    // Notify-only: the owner is told, the conversation is NOT frozen.
    expect(vi.mocked(eventsRepo.insert)).toHaveBeenCalledWith(
      expect.anything(),
      'conv-1',
      'escalated_to_owner',
      { reason: 'video_attachment', notifyOnly: true },
    );
    expect(vi.mocked(escalationsRepo.upsertActive)).not.toHaveBeenCalled();
    expect(vi.mocked(conversationsRepo.setHandoffUntil)).not.toHaveBeenCalled();
    expect(ghl.sendMessage).not.toHaveBeenCalled(); // handle-inbound never talks directly
    expect(respondQueue.add).toHaveBeenCalledOnce(); // the bot still replies to the client
  });

  it('escalates with reason audio_attachment when attachment.type=audio', async () => {
    const ghl = makeGhl({
      getMessage: vi.fn(async () => ({
        text: '',
        attachments: [{ url: 'https://x.test/a.mp3', type: 'audio' as const }],
      })),
    });
    const respondQueue = makeRespondQueue();
    const deps = makeDeps(ghl, respondQueue);

    await handleInbound(deps, baseInput());

    // Notify-only: the owner is told, the conversation is NOT frozen.
    expect(vi.mocked(eventsRepo.insert)).toHaveBeenCalledWith(
      expect.anything(),
      'conv-1',
      'escalated_to_owner',
      { reason: 'audio_attachment', notifyOnly: true },
    );
    expect(vi.mocked(escalationsRepo.upsertActive)).not.toHaveBeenCalled();
    expect(vi.mocked(conversationsRepo.setHandoffUntil)).not.toHaveBeenCalled();
    expect(ghl.sendMessage).not.toHaveBeenCalled(); // handle-inbound never talks directly
    expect(respondQueue.add).toHaveBeenCalledOnce(); // the bot still replies to the client
  });

  it('escalates with reason image_without_url when image attachment has no url', async () => {
    const ghl = makeGhl({
      getMessage: vi.fn(async () => ({
        text: '',
        attachments: [{ url: null, type: 'image' as const }],
      })),
    });
    const respondQueue = makeRespondQueue();
    const deps = makeDeps(ghl, respondQueue);

    await handleInbound(deps, baseInput());

    // Notify-only: the owner is told, the conversation is NOT frozen.
    expect(vi.mocked(eventsRepo.insert)).toHaveBeenCalledWith(
      expect.anything(),
      'conv-1',
      'escalated_to_owner',
      { reason: 'image_without_url', notifyOnly: true },
    );
    expect(vi.mocked(escalationsRepo.upsertActive)).not.toHaveBeenCalled();
    expect(vi.mocked(conversationsRepo.setHandoffUntil)).not.toHaveBeenCalled();
    expect(ghl.sendMessage).not.toHaveBeenCalled(); // handle-inbound never talks directly
    expect(respondQueue.add).toHaveBeenCalledOnce(); // the bot still replies to the client
  });

  it('queues respond job when inbound has text + image with URL, no escalation', async () => {
    const ghl = makeGhl({
      getMessage: vi.fn(async () => ({
        text: 'check this look',
        attachments: [{ url: 'https://x.test/img.jpg', type: 'image' as const }],
      })),
    });
    const respondQueue = makeRespondQueue();
    const deps = makeDeps(ghl, respondQueue);

    await handleInbound(deps, baseInput());

    expect(respondQueue.add).toHaveBeenCalledOnce();
    expect(vi.mocked(escalationsRepo.upsertActive)).not.toHaveBeenCalled();
    // Ensure channelType is 'image' on persist
    expect(vi.mocked(messagesRepo.insertInbound)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ channelType: 'image' }),
    );
  });

  it('queues respond job when text-only inbound (no attachments) — existing behavior preserved', async () => {
    const ghl = makeGhl({
      getMessage: vi.fn(async () => ({ text: 'hi', attachments: [] })),
    });
    const respondQueue = makeRespondQueue();
    const deps = makeDeps(ghl, respondQueue);

    await handleInbound(deps, baseInput());

    expect(respondQueue.add).toHaveBeenCalledOnce();
    expect(vi.mocked(escalationsRepo.upsertActive)).not.toHaveBeenCalled();
    expect(vi.mocked(messagesRepo.insertInbound)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ channelType: 'text', textContent: 'hi' }),
    );
  });

  it('drops inbound with no text and no attachments', async () => {
    const ghl = makeGhl({
      getMessage: vi.fn(async () => ({ text: '', attachments: [] })),
    });
    const respondQueue = makeRespondQueue();
    const deps = makeDeps(ghl, respondQueue);

    await handleInbound(deps, baseInput());

    expect(respondQueue.add).not.toHaveBeenCalled();
    expect(vi.mocked(escalationsRepo.upsertActive)).not.toHaveBeenCalled();
    expect(vi.mocked(messagesRepo.insertInbound)).not.toHaveBeenCalled();
  });

  // B7: a shared reel / story reply / view-once photo arrives as a bare webhook —
  // empty text, empty attachments, but attachments_raw present (the client sent
  // SOMETHING GHL dropped at ingestion). We can't render or decode it, so escalate
  // to the owner rather than sit silent on a high-intent DM.
  it('escalates with reason unviewable_media when webhook is empty but attachments_raw was present (shared reel / view-once)', async () => {
    const ghl = makeGhl();
    const respondQueue = makeRespondQueue();
    const deps = makeDeps(ghl, respondQueue);

    await handleInbound(
      deps,
      baseInput({ messageId: null, messageText: null, rawPayload: { attachments_raw: [] } }),
    );

    // Notify-only: the owner is told, the conversation is NOT frozen.
    expect(vi.mocked(eventsRepo.insert)).toHaveBeenCalledWith(
      expect.anything(),
      'conv-1',
      'escalated_to_owner',
      { reason: 'unviewable_media', notifyOnly: true },
    );
    expect(vi.mocked(escalationsRepo.upsertActive)).not.toHaveBeenCalled();
    expect(vi.mocked(conversationsRepo.setHandoffUntil)).not.toHaveBeenCalled();
    // Persisted as an inbound media row so the owner/analytics has a record.
    expect(vi.mocked(messagesRepo.insertInbound)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ channelType: 'image', textContent: null }),
    );
    // The bot still answers: the prompt receives a marker describing what
    // arrived, so the client gets a warm reply instead of silence while the
    // owner is notified in parallel (QA Round 3, item 4.6).
    expect(ghl.sendMessage).not.toHaveBeenCalled(); // handle-inbound never talks directly
    expect(respondQueue.add).toHaveBeenCalledOnce();
  });

  it('does NOT re-escalate unviewable media when a handoff is already active (self-limiting)', async () => {
    vi.mocked(conversationsRepo.findOrCreate).mockResolvedValue({
      ...fakeConversation,
      handoffUntil: new Date(Date.now() + 3_600_000),
    });
    const ghl = makeGhl();
    const respondQueue = makeRespondQueue();
    const deps = makeDeps(ghl, respondQueue);

    await handleInbound(
      deps,
      baseInput({ messageId: null, messageText: null, rawPayload: { attachments_raw: [] } }),
    );

    expect(vi.mocked(escalationsRepo.upsertActive)).not.toHaveBeenCalled();
    expect(respondQueue.add).not.toHaveBeenCalled();
    // The media row is still persisted before the handoff guard runs.
    expect(vi.mocked(messagesRepo.insertInbound)).toHaveBeenCalled();
  });

  it('still drops (no escalation) when attachments_raw is an empty/"null" string, not a real value', async () => {
    const ghl = makeGhl();
    const respondQueue = makeRespondQueue();
    const deps = makeDeps(ghl, respondQueue);

    await handleInbound(
      deps,
      baseInput({ messageId: null, messageText: null, rawPayload: { attachments_raw: 'null' } }),
    );

    expect(vi.mocked(escalationsRepo.upsertActive)).not.toHaveBeenCalled();
    expect(respondQueue.add).not.toHaveBeenCalled();
    expect(vi.mocked(messagesRepo.insertInbound)).not.toHaveBeenCalled();
  });

});
