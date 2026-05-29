/**
 * Unit tests for handleInbound — Task 12: attachment classification + escalation prečaci.
 *
 * Uses vi.mock to avoid a real DB. All repo calls are stubbed; we assert on
 * the side-effects: respondQueue.add calls, escalation reason, canned sendMessage.
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
    booking_link_dedup_window: 3,
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

  beforeEach(async () => {
    vi.clearAllMocks();
    ({ handleInbound } = await import('../../../src/core/handle-inbound.js'));
    salonsRepo = await import('../../../src/db/repos/salons.js');
    conversationsRepo = await import('../../../src/db/repos/conversations.js');
    messagesRepo = await import('../../../src/db/repos/messages.js');
    escalationsRepo = await import('../../../src/db/repos/escalations.js');

    vi.mocked(salonsRepo.findByLocationId).mockResolvedValue(fakeSalon);
    vi.mocked(conversationsRepo.findOrCreate).mockResolvedValue(fakeConversation);
    vi.mocked(messagesRepo.insertInbound).mockResolvedValue({ id: 'msg-1' });
  });

  it('escalates with reason video_attachment when attachment.type=video, no respond job queued', async () => {
    const ghl = makeGhl({
      getMessage: vi.fn(async () => ({
        text: '',
        attachments: [{ url: 'https://x.test/v.mp4', type: 'video' as const }],
      })),
    });
    const respondQueue = makeRespondQueue();
    const deps = makeDeps(ghl, respondQueue);

    await handleInbound(deps, baseInput());

    expect(vi.mocked(escalationsRepo.upsertActive)).toHaveBeenCalledWith(
      expect.anything(),
      'conv-1',
      'video_attachment',
      null,
    );
    expect(ghl.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        contactId: 'contact-1',
        type: 'IG',
        message: expect.stringContaining('Sarah'),
      }),
    );
    expect((ghl.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][0].message).toContain('video');
    expect(respondQueue.add).not.toHaveBeenCalled();
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

    expect(vi.mocked(escalationsRepo.upsertActive)).toHaveBeenCalledWith(
      expect.anything(),
      'conv-1',
      'audio_attachment',
      null,
    );
    expect(ghl.sendMessage).toHaveBeenCalled();
    expect((ghl.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][0].message).toContain('audio');
    expect(respondQueue.add).not.toHaveBeenCalled();
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

    expect(vi.mocked(escalationsRepo.upsertActive)).toHaveBeenCalledWith(
      expect.anything(),
      'conv-1',
      'image_without_url',
      null,
    );
    expect(ghl.sendMessage).toHaveBeenCalled();
    expect(respondQueue.add).not.toHaveBeenCalled();
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

  it('still escalates even if canned reassurance sendMessage throws (graceful degradation)', async () => {
    const sendMessage = vi.fn(async () => {
      throw new Error('outside 24h IG window');
    });
    const ghl = makeGhl({
      sendMessage,
      getMessage: vi.fn(async () => ({
        text: '',
        attachments: [{ url: 'https://x.test/v.mp4', type: 'video' as const }],
      })),
    });
    const respondQueue = makeRespondQueue();
    const deps = makeDeps(ghl, respondQueue);

    await handleInbound(deps, baseInput());

    // sendMessage was attempted
    expect(sendMessage).toHaveBeenCalled();
    // Escalation still proceeds
    expect(vi.mocked(escalationsRepo.upsertActive)).toHaveBeenCalledWith(
      expect.anything(),
      'conv-1',
      'video_attachment',
      null,
    );
    expect(respondQueue.add).not.toHaveBeenCalled();
  });
});
