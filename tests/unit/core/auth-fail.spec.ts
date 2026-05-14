/**
 * Unit test for D4: GHL 401/403 → disable salon + escalate ghl_auth_failed
 *
 * Uses vi.mock to avoid a real DB connection. All repo calls are stubbed;
 * we only assert on setActive + escalation reason.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GhlApiError } from '../../../src/ghl/errors.js';
import type { GhlClient } from '../../../src/ghl/client.js';
import type { Salon, Conversation, ConversationContext } from '../../../src/core/types.js';
import { FakeLlmClient } from '../../helpers/fake-llm-client.js';

// ── Module mocks ──────────────────────────────────────────────────────────────
// Must be defined before any dynamic import of the module under test.

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

const fakeSalon: Salon = {
  id: 'salon-1',
  displayName: 'Bella Hair Studio',
  ghlLocationId: 'loc-1',
  ghlPit: 'pit-1',
  isActive: true,
  sourceOfTruth: {
    salon: {
      name: 'Bella Hair Studio',
      owner_first_name: 'Sarah',
      location: 'Toronto, ON',
      timezone: 'America/Toronto',
      hours: { mon: 'closed', tue: '10:00-19:00' },
      booking_link: 'https://bellahair.example.com/book',
    },
    stylists: [{ name: 'Sarah', specialties: ['balayage'] }],
    services: [
      {
        name: 'Balayage',
        price_range: { min: 250, max: 400, currency: 'CAD' },
        requires_consultation: true,
      },
    ],
    voice: { tone_notes: 'Warm, casual' },
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

const fakeContext: ConversationContext = {
  conversation: fakeConversation,
  recentMessages: [
    {
      id: 'msg-1',
      conversationId: 'conv-1',
      direction: 'inbound',
      channelType: 'text',
      textContent: 'Hi, I need a haircut',
      aiRawOutput: null,
      sanitizeMods: null,
      ghlMessageId: 'ghl-msg-1',
      createdAt: new Date(),
    },
  ],
  recentEvents: [],
};

// A GHL client that throws 401 on sendMessage, but succeeds on tag/field calls.
const throwing401Ghl: GhlClient = {
  async sendMessage() {
    throw new GhlApiError(401, '/conversations/messages', '{"statusCode":401,"message":"unauthorized"}');
  },
  async getMessage() {
    return { text: '', attachments: [] };
  },
  async addTag() {
    /* no-op */
  },
  async removeTag() {
    /* no-op */
  },
  async updateCustomField() {
    /* no-op */
  },
};

// A GHL client that throws 403 on sendMessage.
const throwing403Ghl: GhlClient = {
  async sendMessage() {
    throw new GhlApiError(403, '/conversations/messages', '{"statusCode":403,"message":"forbidden"}');
  },
  async getMessage() {
    return { text: '', attachments: [] };
  },
  async addTag() {
    /* no-op */
  },
  async removeTag() {
    /* no-op */
  },
  async updateCustomField() {
    /* no-op */
  },
};

// A GHL client that throws a generic 500 on sendMessage.
const throwing500Ghl: GhlClient = {
  async sendMessage() {
    throw new GhlApiError(500, '/conversations/messages', 'internal error');
  },
  async getMessage() {
    return { text: '', attachments: [] };
  },
  async addTag() {
    /* no-op */
  },
  async removeTag() {
    /* no-op */
  },
  async updateCustomField() {
    /* no-op */
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a fake Db with a transaction mock so escalateToOwner's tx works. */
function makeFakeDb() {
  return {
    transaction: () => ({
      execute: async (fn: (tx: unknown) => Promise<void>) => {
        await fn({} /* tx — same as db in mocked context */);
      },
    }),
  } as never;
}

/** Build deps with the given GhlClient and a FakeLlmClient returning plain text. */
function makeDeps(ghl: GhlClient) {
  const llm = new FakeLlmClient();
  llm.stage({ match: () => true, output: { text: 'Hi! How can I help you today?', toolCalls: [] } });
  return {
    db: makeFakeDb(),
    ghl,
    llm,
    defaultLlmModel: 'fake-model',
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('generateResponse — GHL auth failure handling', () => {
  // Import lazily after mocks are set up
  let generateResponse: (typeof import('../../../src/core/generate-response.js'))['generateResponse'];
  let conversationsRepo: typeof import('../../../src/db/repos/conversations.js');
  let salonsRepo: typeof import('../../../src/db/repos/salons.js');
  let escalationsRepo: typeof import('../../../src/db/repos/escalations.js');

  beforeEach(async () => {
    vi.clearAllMocks();
    // (re-)import after clearing so spies are fresh
    ({ generateResponse } = await import('../../../src/core/generate-response.js'));
    conversationsRepo = await import('../../../src/db/repos/conversations.js');
    salonsRepo = await import('../../../src/db/repos/salons.js');
    escalationsRepo = await import('../../../src/db/repos/escalations.js');

    // Wire up loadContext to return our fake context
    vi.mocked(conversationsRepo.loadContext).mockResolvedValue(fakeContext);

    // escalationsRepo.upsertActive needs a mock that accepts the tx arg (same as db arg here)
    vi.mocked(escalationsRepo.upsertActive).mockResolvedValue(undefined);
  });

  it('disables salon when sendMessage throws GhlApiError 401', async () => {
    const deps = makeDeps(throwing401Ghl);

    await generateResponse(deps, fakeSalon, 'conv-1');

    expect(vi.mocked(salonsRepo.setActive)).toHaveBeenCalledWith(deps.db, 'salon-1', false);
  });

  it('escalates with reason ghl_auth_failed when sendMessage throws GhlApiError 401', async () => {
    const deps = makeDeps(throwing401Ghl);

    await generateResponse(deps, fakeSalon, 'conv-1');

    expect(vi.mocked(escalationsRepo.upsertActive)).toHaveBeenCalledWith(
      expect.anything(), // tx
      'conv-1',
      'ghl_auth_failed',
      null,
    );
  });

  it('disables salon when sendMessage throws GhlApiError 403', async () => {
    const deps = makeDeps(throwing403Ghl);

    await generateResponse(deps, fakeSalon, 'conv-1');

    expect(vi.mocked(salonsRepo.setActive)).toHaveBeenCalledWith(deps.db, 'salon-1', false);
  });

  it('escalates with reason ghl_auth_failed when sendMessage throws GhlApiError 403', async () => {
    const deps = makeDeps(throwing403Ghl);

    await generateResponse(deps, fakeSalon, 'conv-1');

    expect(vi.mocked(escalationsRepo.upsertActive)).toHaveBeenCalledWith(
      expect.anything(),
      'conv-1',
      'ghl_auth_failed',
      null,
    );
  });

  it('does NOT disable salon for a non-auth GHL error (500)', async () => {
    const deps = makeDeps(throwing500Ghl);

    await generateResponse(deps, fakeSalon, 'conv-1');

    expect(vi.mocked(salonsRepo.setActive)).not.toHaveBeenCalled();
  });

  it('escalates with reason cannot_reply_outside_window for non-auth GHL error (500)', async () => {
    const deps = makeDeps(throwing500Ghl);

    await generateResponse(deps, fakeSalon, 'conv-1');

    expect(vi.mocked(escalationsRepo.upsertActive)).toHaveBeenCalledWith(
      expect.anything(),
      'conv-1',
      'cannot_reply_outside_window',
      null,
    );
  });
});

describe('escalateToOwner — GHL auth failure in addTag/updateCustomField', () => {
  let escalateToOwner: (typeof import('../../../src/core/escalate.js'))['escalateToOwner'];
  let salonsRepo: typeof import('../../../src/db/repos/salons.js');
  let escalationsRepo: typeof import('../../../src/db/repos/escalations.js');
  let conversationsRepo: typeof import('../../../src/db/repos/conversations.js');
  let eventsRepo: typeof import('../../../src/db/repos/events.js');

  beforeEach(async () => {
    vi.clearAllMocks();
    ({ escalateToOwner } = await import('../../../src/core/escalate.js'));
    salonsRepo = await import('../../../src/db/repos/salons.js');
    escalationsRepo = await import('../../../src/db/repos/escalations.js');
    conversationsRepo = await import('../../../src/db/repos/conversations.js');
    eventsRepo = await import('../../../src/db/repos/events.js');

    vi.mocked(escalationsRepo.upsertActive).mockResolvedValue(undefined);
    vi.mocked(conversationsRepo.setHandoffUntil).mockResolvedValue(undefined);
    vi.mocked(eventsRepo.insert).mockResolvedValue(undefined);
  });



  it('disables salon when addTag throws GhlApiError 401', async () => {
    const ghl: GhlClient = {
      async sendMessage() { return { ghlMessageId: 'x' }; },
      async getMessage() { return { text: '', attachments: [] }; },
      async addTag() { throw new GhlApiError(401, '/contacts/tags', '{"statusCode":401}'); },
      async removeTag() { /* no-op */ },
      async updateCustomField() { /* no-op */ },
    };

    const db = makeFakeDb();
    await escalateToOwner({ db, ghl, salon: fakeSalon, conversation: fakeConversation, reason: 'test' });

    expect(vi.mocked(salonsRepo.setActive)).toHaveBeenCalledWith(db, 'salon-1', false);
  });

  it('disables salon when updateCustomField throws GhlApiError 403', async () => {
    const ghl: GhlClient = {
      async sendMessage() { return { ghlMessageId: 'x' }; },
      async getMessage() { return { text: '', attachments: [] }; },
      async addTag() { /* no-op */ },
      async removeTag() { /* no-op */ },
      async updateCustomField() { throw new GhlApiError(403, '/contacts/customFields', '{"statusCode":403}'); },
    };

    const db = makeFakeDb();
    await escalateToOwner({ db, ghl, salon: fakeSalon, conversation: fakeConversation, reason: 'test' });

    expect(vi.mocked(salonsRepo.setActive)).toHaveBeenCalledWith(db, 'salon-1', false);
  });

  it('does NOT disable salon when addTag throws a non-auth error', async () => {
    const ghl: GhlClient = {
      async sendMessage() { return { ghlMessageId: 'x' }; },
      async getMessage() { return { text: '', attachments: [] }; },
      async addTag() { throw new GhlApiError(500, '/contacts/tags', 'server error'); },
      async removeTag() { /* no-op */ },
      async updateCustomField() { /* no-op */ },
    };

    const db = makeFakeDb();
    await escalateToOwner({ db, ghl, salon: fakeSalon, conversation: fakeConversation, reason: 'test' });

    expect(vi.mocked(salonsRepo.setActive)).not.toHaveBeenCalled();
  });
});
