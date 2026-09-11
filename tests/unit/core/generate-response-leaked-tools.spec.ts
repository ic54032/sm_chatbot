/**
 * Integration tests for leaked tool-call text recovery (production incident
 * 2026-07-06): GPT-4o wrote "[escalate_to_owner(...)]" / "[get_started_link()]"
 * as reply TEXT instead of firing native tools. The orchestrator must strip the
 * syntax from the outgoing message AND recover the intent.
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
  heldEscalationCount: vi.fn().mockResolvedValue(0),
  latestRepliedInboundAt: vi.fn().mockResolvedValue(null),
  recentEscalationWithReason: vi.fn().mockResolvedValue(false),
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

function makeCtx(inboundText: string): ConversationContext {
  return {
    conversation: fakeConversation,
    recentMessages: [
      {
        id: 'msg-1',
        conversationId: 'conv-1',
        direction: 'inbound',
        channelType: 'text',
        textContent: inboundText,
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

/**
 * Stripping survived structured output. Recovery did not, and the difference is
 * the whole point of this file now.
 *
 * The model can no longer make a tool call, so there is no intent hiding in
 * bracket text to rescue — the reason has a field of its own. What it CAN still do
 * is write "[escalate_to_owner(...)]" into `reply`, and `reply` is the one field
 * the client reads, so stripping matters more than it did when the notation at
 * least sat next to a channel we could read. Production 2026-07-06 is the incident
 * behind every string in here, and the prompt still teaches the notation in nine
 * worked examples until those are rewritten.
 */
describe('generateResponse — tool-call syntax inside the reply', () => {
  let generateResponse: (typeof import('../../../src/core/generate-response.js'))['generateResponse'];
  let conversationsRepo: typeof import('../../../src/db/repos/conversations.js');
  let messagesRepo: typeof import('../../../src/db/repos/messages.js');
  let eventsRepo: typeof import('../../../src/db/repos/events.js');
  let escalationsRepo: typeof import('../../../src/db/repos/escalations.js');

  beforeEach(async () => {
    vi.clearAllMocks();
    ({ generateResponse } = await import('../../../src/core/generate-response.js'));
    conversationsRepo = await import('../../../src/db/repos/conversations.js');
    messagesRepo = await import('../../../src/db/repos/messages.js');
    eventsRepo = await import('../../../src/db/repos/events.js');
    escalationsRepo = await import('../../../src/db/repos/escalations.js');
    vi.mocked(escalationsRepo.upsertActive).mockResolvedValue(undefined);
  });

  it('slur incident: strips the bracket block and escalates from the reason field', async () => {
    vi.mocked(conversationsRepo.loadContext).mockResolvedValue(makeCtx('Nigga'));
    const llm = new FakeLlmClient();
    llm.stage({
      match: () => true,
      output: {
        // The notation lands in `reply` now, which is why stripping it is no
        // longer only about tidiness.
        text: 'I\'m letting Renata handle this one. 🤍\n[escalate_to_owner(reason="hostile_language", context_summary="client used hostile language directed at the salon")]',
        toolCalls: [
          {
            name: 'escalate_to_owner',
            arguments: {
              reason: 'hostile_language',
              context_summary: 'client used hostile language directed at the salon',
            },
          },
        ],
      },
    });
    const ghl = makeGhl();
    await generateResponse({ db: makeFakeDb(), ghl, llm, defaultLlmModel: 'fake-model' }, fakeSalon, 'conv-1');

    const sentMessages = vi.mocked(ghl.sendMessage).mock.calls.map((c) => c[0].message);
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]).not.toContain('[');
    expect(sentMessages[0]).not.toContain('escalate_to_owner');
    expect(sentMessages[0]).toContain('letting Renata handle this one');

    expect(vi.mocked(escalationsRepo.upsertActive)).toHaveBeenCalledWith(
      expect.anything(),
      'conv-1',
      'hostile_language',
      'client used hostile language directed at the salon',
    );
    // sanitize_mods records the strip for observability; ai_raw_output keeps
    // the ORIGINAL pre-strip text as forensic evidence
    expect(vi.mocked(messagesRepo.insertOutbound)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        sanitizeMods: expect.arrayContaining(['tool_call_text_stripped']),
        aiRawOutput: expect.stringContaining('[escalate_to_owner('),
      }),
    );
  });

  it('booking incident: strips the invented [get_started_link()], keeps the link, records booking_link_sent', async () => {
    vi.mocked(conversationsRepo.loadContext).mockResolvedValue(makeCtx('How do i do it?'));
    const llm = new FakeLlmClient();
    llm.stage({
      match: () => true,
      output: {
        text: 'Yay! You can book through this link: https://lumenhairstudio.glossgenius.com/book. It will guide you through picking a time. 🤍\n[get_started_link()]',
        toolCalls: [],
      },
    });
    const ghl = makeGhl();
    await generateResponse({ db: makeFakeDb(), ghl, llm, defaultLlmModel: 'fake-model' }, fakeSalon, 'conv-1');

    const sentMessages = vi.mocked(ghl.sendMessage).mock.calls.map((c) => c[0].message);
    expect(sentMessages.join(' ')).not.toContain('get_started_link');
    expect(sentMessages.join(' ')).toContain('https://lumenhairstudio.glossgenius.com/book');
    // No escalation for an unknown leaked name
    expect(vi.mocked(escalationsRepo.upsertActive)).not.toHaveBeenCalled();
    // Link event recorded (post-send containsLink scan also covers this)
    expect(vi.mocked(eventsRepo.insert)).toHaveBeenCalledWith(expect.anything(), 'conv-1', 'booking_link_sent', {});
  });

  /**
   * The dedup window opens on the URL actually being sent, nothing else.
   *
   * This used to assert that a leaked [mark_link_sent()] opened the window even
   * with no URL in the text, which had it backwards: the client never received a
   * link, so a window that suppresses the next one only hides the link further.
   * mark_link_sent was removed on 2026-08-24 and the bracket is now just noise
   * for the extractor to strip.
   */
  it('leaked [mark_link_sent()] without the URL in text records NO booking_link_sent event', async () => {
    vi.mocked(conversationsRepo.loadContext).mockResolvedValue(makeCtx('ok'));
    const llm = new FakeLlmClient();
    llm.stage({
      match: () => true,
      output: { text: 'link is right above whenever you\'re ready 🤍\n[mark_link_sent()]', toolCalls: [] },
    });
    const ghl = makeGhl();
    await generateResponse({ db: makeFakeDb(), ghl, llm, defaultLlmModel: 'fake-model' }, fakeSalon, 'conv-1');

    expect(vi.mocked(eventsRepo.insert)).not.toHaveBeenCalledWith(
      expect.anything(),
      'conv-1',
      'booking_link_sent',
      {},
    );
  });

  it('an allowed state flag merges state', async () => {
    vi.mocked(conversationsRepo.loadContext).mockResolvedValue(makeCtx('im nervous'));
    const llm = new FakeLlmClient();
    llm.stage({
      match: () => true,
      output: {
        text: 'totally get that 🤍',
        toolCalls: [{ name: 'set_state_flag', arguments: { key: 'client_is_hesitant', value: true } }],
      },
    });
    const ghl = makeGhl();
    await generateResponse({ db: makeFakeDb(), ghl, llm, defaultLlmModel: 'fake-model' }, fakeSalon, 'conv-1');

    expect(vi.mocked(conversationsRepo.mergeState)).toHaveBeenCalledWith(expect.anything(), 'conv-1', { client_is_hesitant: true });
    expect(vi.mocked(escalationsRepo.upsertActive)).not.toHaveBeenCalled();
  });

  // The reason field is now the only channel, so bracket text that disagrees with
  // it is just text to be stripped.
  it('the reason field wins over a conflicting reason written in the prose', async () => {
    vi.mocked(conversationsRepo.loadContext).mockResolvedValue(makeCtx('refund now'));
    const llm = new FakeLlmClient();
    llm.stage({
      match: () => true,
      output: {
        text: 'let me grab Renata for you 🤍\n[escalate_to_owner(reason="hostile_language")]',
        toolCalls: [{ name: 'escalate_to_owner', arguments: { reason: 'refund_request' } }],
      },
    });
    const ghl = makeGhl();
    await generateResponse({ db: makeFakeDb(), ghl, llm, defaultLlmModel: 'fake-model' }, fakeSalon, 'conv-1');

    expect(vi.mocked(escalationsRepo.upsertActive)).toHaveBeenCalledWith(expect.anything(), 'conv-1', 'refund_request', null);
  });

  it('reply that is ONLY a leaked escalation block falls back to the canned reassurance line', async () => {
    vi.mocked(conversationsRepo.loadContext).mockResolvedValue(makeCtx('i want a refund'));
    const llm = new FakeLlmClient();
    llm.stage({
      match: () => true,
      output: {
        text: '[escalate_to_owner(reason="refund_request")]',
        toolCalls: [{ name: 'escalate_to_owner', arguments: { reason: 'refund_request' } }],
      },
    });
    const ghl = makeGhl();
    await generateResponse({ db: makeFakeDb(), ghl, llm, defaultLlmModel: 'fake-model' }, fakeSalon, 'conv-1');

    const sentMessages = vi.mocked(ghl.sendMessage).mock.calls.map((c) => c[0].message);
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]).toContain('let me grab Renata');
    expect(sentMessages[0]).not.toContain('[');
    expect(vi.mocked(escalationsRepo.upsertActive)).toHaveBeenCalledWith(expect.anything(), 'conv-1', 'refund_request', null);
    // The strip marker must survive onto the fallback path's mods too
    expect(vi.mocked(messagesRepo.insertOutbound)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        sanitizeMods: expect.arrayContaining(['escalation_fallback_text', 'tool_call_text_stripped']),
      }),
    );
  });

  it('reply that is ONLY a leaked [mark_link_sent()] sends the booking link (same recovery as native link intent), no escalation', async () => {
    vi.mocked(conversationsRepo.loadContext).mockResolvedValue(makeCtx('i want to book'));
    const llm = new FakeLlmClient();
    llm.stage({ match: () => true, output: { text: '[mark_link_sent()]', toolCalls: [] } });
    const ghl = makeGhl();
    await generateResponse({ db: makeFakeDb(), ghl, llm, defaultLlmModel: 'fake-model' }, fakeSalon, 'conv-1');

    const sent = vi.mocked(ghl.sendMessage).mock.calls.map((c) => c[0].message);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('https://lumenhairstudio.glossgenius.com/book');
    expect(vi.mocked(escalationsRepo.upsertActive)).not.toHaveBeenCalled();
    expect(vi.mocked(eventsRepo.insert)).toHaveBeenCalledWith(expect.anything(), 'conv-1', 'booking_link_sent', {});
  });

  /**
   * The JSON Schema enum keeps this out in production, so the check exists for the
   * case the schema cannot cover: a provider that does not constrain output, or a
   * response that arrived some other way. handoff_until is the dangerous example —
   * a model that could set it could pause itself indefinitely.
   */
  it('a disallowed state flag key does NOT merge state', async () => {
    vi.mocked(conversationsRepo.loadContext).mockResolvedValue(makeCtx('hi'));
    const llm = new FakeLlmClient();
    llm.stage({
      match: () => true,
      output: {
        text: 'sure thing 🤍',
        toolCalls: [{ name: 'set_state_flag', arguments: { key: 'handoff_until', value: '2099-01-01' } }],
      },
    });
    const ghl = makeGhl();
    await generateResponse({ db: makeFakeDb(), ghl, llm, defaultLlmModel: 'fake-model' }, fakeSalon, 'conv-1');

    expect(vi.mocked(conversationsRepo.mergeState)).not.toHaveBeenCalled();
    expect(vi.mocked(escalationsRepo.upsertActive)).not.toHaveBeenCalled();
  });

  it('unknown NATIVE tool call is ignored without crashing the turn', async () => {
    vi.mocked(conversationsRepo.loadContext).mockResolvedValue(makeCtx('how do i book'));
    const llm = new FakeLlmClient();
    llm.stage({
      match: () => true,
      output: {
        text: 'here you go: https://lumenhairstudio.glossgenius.com/book 🤍',
        toolCalls: [{ name: 'get_started_link', arguments: {} }],
      },
    });
    const ghl = makeGhl();
    await generateResponse({ db: makeFakeDb(), ghl, llm, defaultLlmModel: 'fake-model' }, fakeSalon, 'conv-1');

    expect(ghl.sendMessage).toHaveBeenCalledTimes(1);
    expect(vi.mocked(escalationsRepo.upsertActive)).not.toHaveBeenCalled();
  });

  it('handoff-promise prose + leaked non-escalation call forces implied_handoff_no_tool_call with a bracket-free summary', async () => {
    vi.mocked(conversationsRepo.loadContext).mockResolvedValue(makeCtx('is this fixable?'));
    const llm = new FakeLlmClient();
    llm.stage({
      match: () => true,
      output: { text: "she'll jump in shortly to help 🤍\n[set_state_flag(\"client_is_hesitant\", true)]", toolCalls: [] },
    });
    const ghl = makeGhl();
    await generateResponse({ db: makeFakeDb(), ghl, llm, defaultLlmModel: 'fake-model' }, fakeSalon, 'conv-1');

    expect(vi.mocked(escalationsRepo.upsertActive)).toHaveBeenCalledWith(
      expect.anything(),
      'conv-1',
      'implied_handoff_no_tool_call',
      expect.not.stringContaining('['),
    );
  });

  /**
   * The owner is still told, and what the model called it is not what she reads.
   *
   * "unspecified" renders as "Needs your attention", which is honest. Dropping the
   * escalation would lose a real handoff over a spelling, and passing the string
   * through would put model-authored text — possibly the client's own words — into
   * her GHL reason field.
   */
  it('a reason outside the enum is reported as "unspecified", not passed through', async () => {
    vi.mocked(conversationsRepo.loadContext).mockResolvedValue(makeCtx('whatever'));
    const llm = new FakeLlmClient();
    llm.stage({
      match: () => true,
      output: {
        text: 'one sec 🤍',
        toolCalls: [{ name: 'escalate_to_owner', arguments: { reason: 'client is a scammer lol' } }],
      },
    });
    const ghl = makeGhl();
    await generateResponse({ db: makeFakeDb(), ghl, llm, defaultLlmModel: 'fake-model' }, fakeSalon, 'conv-1');

    expect(vi.mocked(escalationsRepo.upsertActive)).toHaveBeenCalledWith(expect.anything(), 'conv-1', 'unspecified', null);
  });

  it('turn that sends the link AND escalates still records booking_link_sent (dedup window starts)', async () => {
    vi.mocked(conversationsRepo.loadContext).mockResolvedValue(makeCtx('book me but also complaint'));
    const llm = new FakeLlmClient();
    llm.stage({
      match: () => true,
      output: {
        text: 'here you go: https://lumenhairstudio.glossgenius.com/book 🤍 and let me get Renata on this right away',
        toolCalls: [{ name: 'escalate_to_owner', arguments: { reason: 'this_salon_complaint' } }],
      },
    });
    const ghl = makeGhl();
    await generateResponse({ db: makeFakeDb(), ghl, llm, defaultLlmModel: 'fake-model' }, fakeSalon, 'conv-1');

    expect(vi.mocked(eventsRepo.insert)).toHaveBeenCalledWith(expect.anything(), 'conv-1', 'booking_link_sent', {});
    expect(vi.mocked(escalationsRepo.upsertActive)).toHaveBeenCalledWith(
      expect.anything(),
      'conv-1',
      'this_salon_complaint',
      null,
    );
  });
});
