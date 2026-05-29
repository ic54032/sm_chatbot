/**
 * Unit tests for Task 13: generate-response image fetch orchestration.
 *
 * Stubs repo modules via vi.mock so no DB is touched. The fetcher is injected
 * via deps.fetchAttachment to control success/failure deterministically.
 *
 * Scenarios:
 *  1. Current inbound has image + fetch succeeds → LLM gets ContentBlock[] with image block.
 *  2. Current inbound has image + fetch fails → escalate 'attachment_fetch_failed', no LLM call.
 *  3. Historical inbound has image (fetch fails) but current is text-only → log+skip, no escalate, LLM called.
 *  4. salon.config.image_processing.enabled=false + current inbound has image → escalate 'image_processing_disabled', no fetch/LLM.
 *  5. No inbound has images → LLM gets plain string content for every message.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GhlClient } from '../../../src/ghl/client.js';
import type { Salon, Conversation, ConversationContext, Message } from '../../../src/core/types.js';
import { FakeLlmClient } from '../../helpers/fake-llm-client.js';
import { AttachmentFetchError } from '../../../src/images/errors.js';

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('../../../src/db/repos/conversations.js', () => ({
  loadContext: vi.fn(),
  setHandoffUntil: vi.fn().mockResolvedValue(undefined),
  mergeState: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/db/repos/messages.js', () => ({
  insertOutbound: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/db/repos/events.js', () => ({
  recentBookingLinkSent: vi.fn().mockResolvedValue(false),
  insert: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/db/repos/escalations.js', () => ({
  upsertActive: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/db/repos/salons.js', () => ({
  setActive: vi.fn().mockResolvedValue(undefined),
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

const FIX = join(dirname(fileURLToPath(import.meta.url)), '../images/fixtures');
const realJpegBytes = readFileSync(join(FIX, 'small-800x600.jpg'));

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

function makeInbound(id: string, opts: { text?: string | null; attachments?: Array<{ url: string; type: string }> } = {}): Message {
  const rawContent = opts.attachments ? { attachments: opts.attachments } : null;
  return {
    id,
    conversationId: 'conv-1',
    direction: 'inbound',
    channelType: opts.attachments ? 'image' : 'text',
    textContent: opts.text ?? null,
    aiRawOutput: null,
    sanitizeMods: null,
    ghlMessageId: `ghl-${id}`,
    createdAt: new Date(),
    rawContent,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeFakeDb() {
  return {
    transaction: () => ({
      execute: async (fn: (tx: unknown) => Promise<void>) => {
        await fn({});
      },
    }),
  } as never;
}

function makeGhl(): GhlClient {
  return {
    sendMessage: vi.fn(async () => ({ ghlMessageId: 'sent-msg-1' })),
    getMessage: vi.fn(async () => ({ text: '', attachments: [] })),
    addTag: vi.fn(async () => undefined),
    removeTag: vi.fn(async () => undefined),
    updateCustomField: vi.fn(async () => undefined),
  };
}

function makeDeps(
  llm: FakeLlmClient,
  fetchAttachment?: (url: string, pit: string) => Promise<Buffer>,
) {
  return {
    db: makeFakeDb(),
    ghl: makeGhl(),
    llm,
    defaultLlmModel: 'fake-model',
    fetchAttachment: fetchAttachment as never,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('generateResponse image orchestration', () => {
  let generateResponse: (typeof import('../../../src/core/generate-response.js'))['generateResponse'];
  let conversationsRepo: typeof import('../../../src/db/repos/conversations.js');
  let escalationsRepo: typeof import('../../../src/db/repos/escalations.js');

  beforeEach(async () => {
    vi.clearAllMocks();
    ({ generateResponse } = await import('../../../src/core/generate-response.js'));
    conversationsRepo = await import('../../../src/db/repos/conversations.js');
    escalationsRepo = await import('../../../src/db/repos/escalations.js');
    vi.mocked(escalationsRepo.upsertActive).mockResolvedValue(undefined);
  });

  it('passes image content block to LLM when current inbound has image and fetch succeeds', async () => {
    const ctx: ConversationContext = {
      conversation: fakeConversation,
      recentMessages: [
        makeInbound('msg-1', {
          text: 'check this look',
          attachments: [{ url: 'https://x.test/a.jpg', type: 'image' }],
        }),
      ],
      recentEvents: [],
    };
    vi.mocked(conversationsRepo.loadContext).mockResolvedValue(ctx);

    const llm = new FakeLlmClient();
    llm.stage({ match: () => true, output: { text: 'love that look 🤍', toolCalls: [] } });

    const fetcher = vi.fn(async () => realJpegBytes);
    const deps = makeDeps(llm, fetcher);

    await generateResponse(deps, fakeSalon, 'conv-1');

    expect(fetcher).toHaveBeenCalledWith('https://x.test/a.jpg', 'pit-1');
    expect(llm.calls).toHaveLength(1);
    const firstMessage = llm.calls[0].messages[0];
    expect(Array.isArray(firstMessage.content)).toBe(true);
    const blocks = firstMessage.content as Array<{ type: string }>;
    const imageBlocks = blocks.filter((b) => b.type === 'image');
    expect(imageBlocks.length).toBeGreaterThanOrEqual(1);
    expect(vi.mocked(escalationsRepo.upsertActive)).not.toHaveBeenCalled();
  });

  it('escalates with attachment_fetch_failed when current-turn image fetch fails', async () => {
    const ctx: ConversationContext = {
      conversation: fakeConversation,
      recentMessages: [
        makeInbound('msg-1', {
          text: 'look at this',
          attachments: [{ url: 'https://x.test/a.jpg', type: 'image' }],
        }),
      ],
      recentEvents: [],
    };
    vi.mocked(conversationsRepo.loadContext).mockResolvedValue(ctx);

    const llm = new FakeLlmClient();
    llm.stage({ match: () => true, output: { text: 'should not be called', toolCalls: [] } });

    const fetcher = vi.fn(async (url: string) => {
      throw new AttachmentFetchError(404, url);
    });
    const deps = makeDeps(llm, fetcher);

    await generateResponse(deps, fakeSalon, 'conv-1');

    expect(fetcher).toHaveBeenCalledWith('https://x.test/a.jpg', 'pit-1');
    expect(llm.calls).toHaveLength(0);
    expect(vi.mocked(escalationsRepo.upsertActive)).toHaveBeenCalledWith(
      expect.anything(),
      'conv-1',
      'attachment_fetch_failed',
      null,
    );
  });

  it('logs and skips historical image failure without escalating', async () => {
    // m1 (older): image; m2 (current/last): text-only
    const m1 = makeInbound('msg-1', {
      text: 'remember this?',
      attachments: [{ url: 'https://x.test/old.jpg', type: 'image' }],
    });
    const m2 = makeInbound('msg-2', { text: 'still thinking about it' });
    const ctx: ConversationContext = {
      conversation: fakeConversation,
      recentMessages: [m1, m2],
      recentEvents: [],
    };
    vi.mocked(conversationsRepo.loadContext).mockResolvedValue(ctx);

    const llm = new FakeLlmClient();
    llm.stage({ match: () => true, output: { text: 'totally hear you 🤍', toolCalls: [] } });

    const fetcher = vi.fn(async (url: string) => {
      throw new AttachmentFetchError(404, url);
    });
    const deps = makeDeps(llm, fetcher);

    await generateResponse(deps, fakeSalon, 'conv-1');

    // Fetch was attempted for the historical image
    expect(fetcher).toHaveBeenCalledWith('https://x.test/old.jpg', 'pit-1');
    // No escalation: current turn (m2) has no images
    expect(vi.mocked(escalationsRepo.upsertActive)).not.toHaveBeenCalled();
    // LLM was called
    expect(llm.calls).toHaveLength(1);
    const msgs = llm.calls[0].messages;
    // m1's content is a string (image skipped due to fetch fail) and m2 likewise
    expect(typeof msgs[0].content).toBe('string');
    expect(typeof msgs[1].content).toBe('string');
  });

  it('escalates with image_processing_disabled when salon image_processing.enabled is false and inbound has image', async () => {
    const disabledSalon: Salon = {
      ...fakeSalon,
      config: {
        ...fakeSalon.config,
        image_processing: { enabled: false, max_dimension: 1280, jpeg_quality: 80 },
      },
    };
    const ctx: ConversationContext = {
      conversation: fakeConversation,
      recentMessages: [
        makeInbound('msg-1', {
          text: 'pic',
          attachments: [{ url: 'https://x.test/a.jpg', type: 'image' }],
        }),
      ],
      recentEvents: [],
    };
    vi.mocked(conversationsRepo.loadContext).mockResolvedValue(ctx);

    const llm = new FakeLlmClient();
    llm.stage({ match: () => true, output: { text: 'should not be called', toolCalls: [] } });

    const fetcher = vi.fn();
    const deps = makeDeps(llm, fetcher as never);

    await generateResponse(deps, disabledSalon, 'conv-1');

    expect(fetcher).not.toHaveBeenCalled();
    expect(llm.calls).toHaveLength(0);
    expect(vi.mocked(escalationsRepo.upsertActive)).toHaveBeenCalledWith(
      expect.anything(),
      'conv-1',
      'image_processing_disabled',
      null,
    );
  });

  it('passes string content when no inbound message has images', async () => {
    const ctx: ConversationContext = {
      conversation: fakeConversation,
      recentMessages: [
        makeInbound('msg-1', { text: 'hi there' }),
        makeInbound('msg-2', { text: 'do you do balayage?' }),
      ],
      recentEvents: [],
    };
    vi.mocked(conversationsRepo.loadContext).mockResolvedValue(ctx);

    const llm = new FakeLlmClient();
    llm.stage({ match: () => true, output: { text: 'yes! 🤍', toolCalls: [] } });

    const fetcher = vi.fn();
    const deps = makeDeps(llm, fetcher as never);

    await generateResponse(deps, fakeSalon, 'conv-1');

    expect(fetcher).not.toHaveBeenCalled();
    expect(llm.calls).toHaveLength(1);
    for (const m of llm.calls[0].messages) {
      expect(typeof m.content).toBe('string');
    }
    expect(vi.mocked(escalationsRepo.upsertActive)).not.toHaveBeenCalled();
  });
});
