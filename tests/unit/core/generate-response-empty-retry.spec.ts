/**
 * Empty-output retry (production report 2026-07-10): GPT-4o intermittently
 * returns text that sanitizes to nothing, with no tool call, on very short
 * affirmations ("yes", "indeed"). Before this fix that blank response escalated
 * a booking-intent customer straight to the owner. Now the generation is
 * retried once; only a SECOND empty result escalates.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GhlClient } from '../../../src/ghl/client.js';
import type { Salon, Conversation, ConversationContext } from '../../../src/core/types.js';
import { FakeLlmClient } from '../../helpers/fake-llm-client.js';

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

const fakeSalon: Salon = {
  id: 'salon-1',
  displayName: 'Lumen Hair Studio',
  ghlLocationId: 'loc-1',
  ghlPit: 'pit-1',
  isActive: true,
  sourceOfTruth: {
    salon_basics: { salon_name: 'Lumen Hair Studio', owner_first_name: 'Renata' },
    booking: { url: 'https://lumenhairstudio.glossgenius.com/book' },
    price_quoting_policy: 'b',
  },
  config: {
    response_delay_ms: 100,
    handoff_window_hours: 4,
    booking_link_dedup_window_hours: 24,
    max_words_per_message: 40,
    max_emojis: 2,
    ghl_custom_field_ids: { needs_owner_attention: 'a', bot_paused_until: 'b', last_escalation_reason: 'c' },
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

function makeCtx(text: string): ConversationContext {
  return {
    conversation: fakeConversation,
    recentMessages: [
      {
        id: 'msg-1',
        conversationId: 'conv-1',
        direction: 'inbound',
        channelType: 'text',
        textContent: text,
        aiRawOutput: null,
        sanitizeMods: null,
        ghlMessageId: 'ghl-msg-1',
        createdAt: new Date(),
        rawContent: null,
      },
    ],
    recentEvents: [],
  };
}

function makeFakeDb() {
  return {
    transaction: () => ({ execute: async (fn: (tx: unknown) => Promise<void>) => { await fn({}); } }),
  } as never;
}

function makeGhl(): GhlClient {
  return {
    sendMessage: vi.fn(async () => ({ ghlMessageId: 'sent-1' })),
    getMessage: vi.fn(async () => ({ text: '', attachments: [] })),
    addTag: vi.fn(async () => undefined),
    removeTag: vi.fn(async () => undefined),
    updateCustomField: vi.fn(async () => undefined),
  };
}

describe('generateResponse — empty-output retry', () => {
  let generateResponse: (typeof import('../../../src/core/generate-response.js'))['generateResponse'];
  let conversationsRepo: typeof import('../../../src/db/repos/conversations.js');
  let escalationsRepo: typeof import('../../../src/db/repos/escalations.js');
  let eventsRepo: typeof import('../../../src/db/repos/events.js');

  beforeEach(async () => {
    vi.clearAllMocks();
    ({ generateResponse } = await import('../../../src/core/generate-response.js'));
    conversationsRepo = await import('../../../src/db/repos/conversations.js');
    escalationsRepo = await import('../../../src/db/repos/escalations.js');
    eventsRepo = await import('../../../src/db/repos/events.js');
    vi.mocked(escalationsRepo.upsertActive).mockResolvedValue(undefined);
    vi.mocked(eventsRepo.recentBookingLinkSent).mockResolvedValue(false);
  });

  it('blank first response retries, and the SECOND (real) response is sent — no escalation', async () => {
    vi.mocked(conversationsRepo.loadContext).mockResolvedValue(makeCtx('yes'));
    const llm = new FakeLlmClient();
    let n = 0;
    llm.stage({ match: () => n++ === 0, output: { text: '', toolCalls: [] } });
    llm.stage({ match: () => true, output: { text: 'yay 🤍 here you go: https://lumenhairstudio.glossgenius.com/book', toolCalls: [] } });
    const ghl = makeGhl();

    await generateResponse({ db: makeFakeDb(), ghl, llm, defaultLlmModel: 'fake-model' }, fakeSalon, 'conv-1');

    expect(llm.calls).toHaveLength(2); // retried once
    const sent = vi.mocked(ghl.sendMessage).mock.calls.map((c) => c[0].message);
    expect(sent.join(' ')).toContain('https://lumenhairstudio.glossgenius.com/book');
    expect(vi.mocked(escalationsRepo.upsertActive)).not.toHaveBeenCalled();
  });

  it('blank on BOTH attempts escalates sanitizer_empty_output and sends nothing', async () => {
    vi.mocked(conversationsRepo.loadContext).mockResolvedValue(makeCtx('indeed'));
    const llm = new FakeLlmClient();
    llm.stage({ match: () => true, output: { text: '', toolCalls: [] } });
    const ghl = makeGhl();

    await generateResponse({ db: makeFakeDb(), ghl, llm, defaultLlmModel: 'fake-model' }, fakeSalon, 'conv-1');

    expect(llm.calls).toHaveLength(2); // original + one retry
    expect(ghl.sendMessage).not.toHaveBeenCalled();
    expect(vi.mocked(escalationsRepo.upsertActive)).toHaveBeenCalledWith(
      expect.anything(),
      'conv-1',
      'sanitizer_empty_output',
      null,
    );
  });

  it('text that SANITIZES to empty (pure ellipsis) also retries, not just literally-blank text', async () => {
    vi.mocked(conversationsRepo.loadContext).mockResolvedValue(makeCtx('yes'));
    const llm = new FakeLlmClient();
    let n = 0;
    // First response is only ellipses (scrubbed to empty by the sanitizer),
    // second is a real reply.
    llm.stage({ match: () => n++ === 0, output: { text: '………', toolCalls: [] } });
    llm.stage({ match: () => true, output: { text: 'sounds good 🤍', toolCalls: [] } });
    const ghl = makeGhl();

    await generateResponse({ db: makeFakeDb(), ghl, llm, defaultLlmModel: 'fake-model' }, fakeSalon, 'conv-1');

    expect(llm.calls).toHaveLength(2);
    expect(vi.mocked(ghl.sendMessage).mock.calls[0][0].message).toContain('sounds good');
    expect(vi.mocked(escalationsRepo.upsertActive)).not.toHaveBeenCalled();
  });

  it('empty text WITH mark_link_sent (link intent) sends the booking URL instead of escalating — the confirmed 2026-07-10 bug', async () => {
    vi.mocked(conversationsRepo.loadContext).mockResolvedValue(makeCtx('i want to book an apointment'));
    const llm = new FakeLlmClient();
    // Exact production shape: empty text, mark_link_sent + set_state_flag fired.
    llm.stage({
      match: () => true,
      output: {
        text: '',
        toolCalls: [
          { name: 'mark_link_sent', arguments: {} },
          { name: 'set_state_flag', arguments: { key: 'client_is_hesitant', value: false } },
        ],
      },
    });
    const ghl = makeGhl();

    await generateResponse({ db: makeFakeDb(), ghl, llm, defaultLlmModel: 'fake-model' }, fakeSalon, 'conv-1');

    expect(llm.calls).toHaveLength(1); // no retry: link intent is clear
    const sent = vi.mocked(ghl.sendMessage).mock.calls.map((c) => c[0].message);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('https://lumenhairstudio.glossgenius.com/book');
    expect(vi.mocked(escalationsRepo.upsertActive)).not.toHaveBeenCalled();
    // dedup window starts
    expect(vi.mocked(eventsRepo.insert)).toHaveBeenCalledWith(expect.anything(), 'conv-1', 'booking_link_sent', {});
  });

  it('empty text + mark_link_sent when link was already sent recently sends a nudge (no re-pasted URL)', async () => {
    vi.mocked(conversationsRepo.loadContext).mockResolvedValue(makeCtx("i'd book"));
    vi.mocked(eventsRepo.recentBookingLinkSent).mockResolvedValue(true);
    const llm = new FakeLlmClient();
    llm.stage({ match: () => true, output: { text: '', toolCalls: [{ name: 'mark_link_sent', arguments: {} }] } });
    const ghl = makeGhl();

    await generateResponse({ db: makeFakeDb(), ghl, llm, defaultLlmModel: 'fake-model' }, fakeSalon, 'conv-1');

    const sent = vi.mocked(ghl.sendMessage).mock.calls.map((c) => c[0].message);
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toContain('https://lumenhairstudio.glossgenius.com/book');
    expect(sent[0].toLowerCase()).toContain('link');
    expect(vi.mocked(escalationsRepo.upsertActive)).not.toHaveBeenCalled();
  });

  it('empty text WITH a real escalate_to_owner tool does NOT retry — canned reassurance + escalation on the first attempt', async () => {
    vi.mocked(conversationsRepo.loadContext).mockResolvedValue(makeCtx('i want a refund'));
    const llm = new FakeLlmClient();
    llm.stage({
      match: () => true,
      output: { text: '', toolCalls: [{ name: 'escalate_to_owner', arguments: { reason: 'refund_request' } }] },
    });
    const ghl = makeGhl();

    await generateResponse({ db: makeFakeDb(), ghl, llm, defaultLlmModel: 'fake-model' }, fakeSalon, 'conv-1');

    expect(llm.calls).toHaveLength(1); // no empty-retry: escalation intent short-circuits it
    const sent = vi.mocked(ghl.sendMessage).mock.calls.map((c) => c[0].message);
    expect(sent[0]).toContain('let me grab Renata');
    expect(vi.mocked(escalationsRepo.upsertActive)).toHaveBeenCalledWith(expect.anything(), 'conv-1', 'refund_request', null);
  });
});
