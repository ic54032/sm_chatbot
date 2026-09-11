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
  latestRepliedInboundAt: vi.fn().mockResolvedValue(null),
  recentEscalationWithReason: vi.fn().mockResolvedValue(false),
  heldEscalationCount: vi.fn().mockResolvedValue(0),
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
  let messagesRepo: typeof import('../../../src/db/repos/messages.js');

  beforeEach(async () => {
    vi.clearAllMocks();
    ({ generateResponse } = await import('../../../src/core/generate-response.js'));
    conversationsRepo = await import('../../../src/db/repos/conversations.js');
    escalationsRepo = await import('../../../src/db/repos/escalations.js');
    eventsRepo = await import('../../../src/db/repos/events.js');
    messagesRepo = await import('../../../src/db/repos/messages.js');
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

  it('blank on BOTH attempts sends a reassurance line THEN escalates (never dead air) — B5', async () => {
    vi.mocked(conversationsRepo.loadContext).mockResolvedValue(makeCtx('indeed'));
    const llm = new FakeLlmClient();
    llm.stage({ match: () => true, output: { text: '', toolCalls: [] } });
    const ghl = makeGhl();

    await generateResponse({ db: makeFakeDb(), ghl, llm, defaultLlmModel: 'fake-model' }, fakeSalon, 'conv-1');

    expect(llm.calls).toHaveLength(2); // original + one retry
    // The client must NOT get pure silence: a reassurance line goes out first.
    const sent = vi.mocked(ghl.sendMessage).mock.calls.map((c) => c[0].message);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('let me grab Renata');
    // and the escalation still fires afterward.
    expect(vi.mocked(escalationsRepo.upsertActive)).toHaveBeenCalledWith(
      expect.anything(),
      'conv-1',
      'sanitizer_empty_output',
      null,
    );
  });

  it('answered-guard: newest inbound already answered -> no LLM, no send, no escalation (B6 double-reply prevention)', async () => {
    const answeredAt = new Date('2026-07-16T10:00:00Z');
    const ctx = makeCtx('hi');
    // The single inbound's created_at equals what a prior reply already answered.
    ctx.recentMessages[0].createdAt = answeredAt;
    vi.mocked(conversationsRepo.loadContext).mockResolvedValue(ctx);
    vi.mocked(eventsRepo.latestRepliedInboundAt).mockResolvedValue(answeredAt);
    const llm = new FakeLlmClient();
    const ghl = makeGhl();

    await generateResponse({ db: makeFakeDb(), ghl, llm, defaultLlmModel: 'fake-model' }, fakeSalon, 'conv-1');

    expect(llm.calls).toHaveLength(0); // already answered -> guard returns
    expect(ghl.sendMessage).not.toHaveBeenCalled();
    expect(vi.mocked(escalationsRepo.upsertActive)).not.toHaveBeenCalled();
  });

  it('answered-guard: a newer inbound than last answered DOES get processed (drain delivers the stranded message)', async () => {
    const answeredAt = new Date('2026-07-16T10:00:00Z');
    const newerInbound = new Date('2026-07-16T10:00:05Z'); // arrived after the prior reply
    const ctx = makeCtx('how much?');
    ctx.recentMessages[0].createdAt = newerInbound;
    vi.mocked(conversationsRepo.loadContext).mockResolvedValue(ctx);
    vi.mocked(eventsRepo.latestRepliedInboundAt).mockResolvedValue(answeredAt);
    const llm = new FakeLlmClient();
    llm.stage({ match: () => true, output: { text: 'balayage starts around $220 🤍', toolCalls: [] } });
    const ghl = makeGhl();

    await generateResponse({ db: makeFakeDb(), ghl, llm, defaultLlmModel: 'fake-model' }, fakeSalon, 'conv-1');

    expect(llm.calls).toHaveLength(1); // newer than answered -> proceeds
    expect(ghl.sendMessage).toHaveBeenCalledTimes(1);
    // and it records what it answered
    expect(vi.mocked(eventsRepo.insert)).toHaveBeenCalledWith(
      expect.anything(),
      'conv-1',
      'replied',
      { answeredInboundAt: newerInbound.toISOString() },
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

    // The corrective retry runs first now; both attempts are empty here, so the
    // canned link fallback is the backstop that still saves the turn.
    expect(llm.calls).toHaveLength(2);
    const sent = vi.mocked(ghl.sendMessage).mock.calls.map((c) => c[0].message);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('https://lumenhairstudio.glossgenius.com/book');
    expect(vi.mocked(escalationsRepo.upsertActive)).not.toHaveBeenCalled();
    // dedup window starts
    expect(vi.mocked(eventsRepo.insert)).toHaveBeenCalledWith(expect.anything(), 'conv-1', 'booking_link_sent', {});
  });

  // QA 4.2: the "hesitant first-timer lost all empathy" regression was never a
  // prompt regression — it was this canned line firing because the model wrote
  // no text. With the corrective retry the model's own words go out instead.
  it('link intent + empty text: the corrective retry writes a real reply, and the link intent is NOT lost', async () => {
    vi.mocked(conversationsRepo.loadContext).mockResolvedValue(
      makeCtx('i want to go blonde but my hair is really dark and im scared of damage'),
    );
    const llm = new FakeLlmClient();
    let n = 0;
    llm.stage({
      match: () => n++ === 0,
      output: { text: '', toolCalls: [{ name: 'mark_link_sent', arguments: {} }] },
    });
    llm.stage({
      match: () => true,
      output: {
        text: 'totally get that 🤍 going lighter safely starts with a free consult so renata can map out a plan: https://lumenhairstudio.glossgenius.com/book',
        toolCalls: [],
      },
    });
    const ghl = makeGhl();

    await generateResponse({ db: makeFakeDb(), ghl, llm, defaultLlmModel: 'fake-model' }, fakeSalon, 'conv-1');

    expect(llm.calls).toHaveLength(2);
    expect(llm.calls[1].tools).toEqual([]); // tools dropped to force text
    const sent = vi.mocked(ghl.sendMessage).mock.calls.map((c) => c[0].message);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('totally get that'); // empathy, not the canned line
    expect(sent[0]).not.toContain('here you go 🤍 https'); // NOT the canned fallback
    // The link intent from attempt 0 survived the tool-less retry.
    expect(vi.mocked(eventsRepo.insert)).toHaveBeenCalledWith(expect.anything(), 'conv-1', 'booking_link_sent', {});
  });

  /**
   * The dedup window must never withhold the URL on this path.
   *
   * This test used to assert the opposite, and the behaviour it locked in reached
   * a real client: on 2026-08-23 18:33 someone typed "Could you send it again",
   * the model produced no text, the link had gone out recently, and what went
   * back was "the booking link I sent has all the latest openings" — a sentence
   * about a link, containing no link.
   *
   * The dedup window exists to stop the bot re-pasting the URL unprompted in
   * ordinary replies. This path only runs because we already failed to write the
   * client a reply, so there is nothing here worth protecting them from.
   */
  it('empty text + booking intent sends the URL even when the link went out recently', async () => {
    vi.mocked(conversationsRepo.loadContext).mockResolvedValue(makeCtx('could you send it again'));
    vi.mocked(eventsRepo.recentBookingLinkSent).mockResolvedValue(true);
    const llm = new FakeLlmClient();
    llm.stage({ match: () => true, output: { text: '', toolCalls: [{ name: 'set_state_flag', arguments: { key: 'client_is_hesitant', value: true } }] } });
    const ghl = makeGhl();

    await generateResponse({ db: makeFakeDb(), ghl, llm, defaultLlmModel: 'fake-model' }, fakeSalon, 'conv-1');

    const sent = vi.mocked(ghl.sendMessage).mock.calls.map((c) => c[0].message);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('https://lumenhairstudio.glossgenius.com/book');
    expect(vi.mocked(escalationsRepo.upsertActive)).not.toHaveBeenCalled();
  });

  // QA 4.1: escalating with empty text had become the habit, so three different
  // situations (refund, medical, price contradiction) all shipped the SAME
  // hardcoded sentence. The corrective retry now gets the model to write its own
  // contextual line, while the escalation it already signalled is preserved.
  it('the corrective retry writes a CONTEXTUAL line and its own reason escalates', async () => {
    vi.mocked(conversationsRepo.loadContext).mockResolvedValue(makeCtx('i want a refund'));
    const llm = new FakeLlmClient();
    let n = 0;
    llm.stage({
      match: () => n++ === 0,
      output: { text: '', toolCalls: [{ name: 'escalate_to_owner', arguments: { reason: 'refund_request' } }] },
    });
    llm.stage({
      match: () => true,
      output: {
        text: "i'm so sorry about that 🤍 renata handles refunds personally, she'll come back to you today",
        toolCalls: [{ name: 'escalate_to_owner', arguments: { reason: 'refund_request' } }],
      },
    });
    const ghl = makeGhl();

    await generateResponse({ db: makeFakeDb(), ghl, llm, defaultLlmModel: 'fake-model' }, fakeSalon, 'conv-1');

    expect(llm.calls).toHaveLength(2);
    const sent = vi.mocked(ghl.sendMessage).mock.calls.map((c) => c[0].message);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('so sorry about that'); // refund-shaped warmth
    expect(sent[0]).not.toContain("she'll jump in as soon as"); // NOT the canned line
    expect(vi.mocked(escalationsRepo.upsertActive)).toHaveBeenCalledWith(expect.anything(), 'conv-1', 'refund_request', null);
  });

  /**
   * The counterpart, and it used to fail.
   *
   * Under tool calling the retry ran with its tools taken away, so it could not
   * re-signal an escalation the first attempt had asked for. A reason therefore had
   * to be CARRIED across, and carrying it caused its own production bug: on
   * 2026-08-30 a media turn's first attempt escalated with no text, the retry wrote
   * "send over what you're hoping to achieve with your hair", and the carried
   * reason paused the bot for twelve hours on a conversation that had just invited
   * the client to answer.
   *
   * A retry now returns a whole reply object, reason included, so it can say for
   * itself. When it declines, that is a decision made with the full conversation in
   * view, and the attempt it overrules wrote nothing — so nothing was promised and
   * there is nothing to keep. A retry that DOES promise a handoff while leaving the
   * reason null is still caught by the net further down.
   */
  it('an intent from an attempt that wrote nothing does not outlive a retry that declines it', async () => {
    vi.mocked(conversationsRepo.loadContext).mockResolvedValue(makeCtx('(sent a video)'));
    const llm = new FakeLlmClient();
    let n = 0;
    llm.stage({
      match: () => n++ === 0,
      output: { text: '', toolCalls: [{ name: 'escalate_to_owner', arguments: { reason: 'unanswered_question' } }] },
    });
    llm.stage({
      match: () => true,
      output: { text: "send over what you're hoping to achieve with your hair, would love to help!", toolCalls: [] },
    });
    const ghl = makeGhl();

    await generateResponse({ db: makeFakeDb(), ghl, llm, defaultLlmModel: 'fake-model' }, fakeSalon, 'conv-1');

    expect(vi.mocked(ghl.sendMessage)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(escalationsRepo.upsertActive)).not.toHaveBeenCalled();
    expect(vi.mocked(conversationsRepo.setHandoffUntil)).not.toHaveBeenCalled();
    expect(vi.mocked(eventsRepo.insert)).not.toHaveBeenCalledWith(
      expect.anything(),
      'conv-1',
      'escalated_to_owner',
      expect.anything(),
    );
  });

  /**
   * T2 in Rounds 3, 4 and 5 — the same capture every time, twice after being
   * reported fixed.
   *
   * The client's words are deliberately absent from every assertion here. What is
   * counted is the model's own request to hand over, so these tests drive
   * heldEscalationCount and never a phrase.
   */
  it('holds the first consultation pushback: no tag, no pause, and the client still gets a reply', async () => {
    vi.mocked(eventsRepo.heldEscalationCount).mockResolvedValue(0);
    vi.mocked(conversationsRepo.loadContext).mockResolvedValue(makeCtx('i literally cannot come in just to talk'));
    const llm = new FakeLlmClient();
    llm.stage({
      match: () => true,
      output: {
        text: 'the consult is short and it is how renata builds the exact plan',
        toolCalls: [{ name: 'escalate_to_owner', arguments: { reason: 'client_refused_consultation_path' } }],
      },
    });
    const ghl = makeGhl();

    const result = await generateResponse(
      { db: makeFakeDb(), ghl, llm, defaultLlmModel: 'fake-model' },
      fakeSalon,
      'conv-1',
    );

    // The DoD for T2: the client gets an answer and GHL hears nothing at all.
    expect(vi.mocked(ghl.sendMessage)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(ghl.addTag)).not.toHaveBeenCalled();
    expect(vi.mocked(ghl.updateCustomField)).not.toHaveBeenCalled();
    expect(vi.mocked(escalationsRepo.upsertActive)).not.toHaveBeenCalled();
    expect(vi.mocked(conversationsRepo.setHandoffUntil)).not.toHaveBeenCalled();
    // The bot is still live, so a message that landed mid-turn must be re-driven.
    expect(result.latestInboundAt).not.toBeNull();
  });

  it('records exactly one escalation_held event when it holds', async () => {
    vi.mocked(eventsRepo.heldEscalationCount).mockResolvedValue(0);
    vi.mocked(conversationsRepo.loadContext).mockResolvedValue(makeCtx('cant you just tell me'));
    const llm = new FakeLlmClient();
    llm.stage({
      match: () => true,
      output: {
        text: 'the consult is short and renata plans it with you there',
        toolCalls: [{ name: 'escalate_to_owner', arguments: { reason: 'client_refused_consultation_path' } }],
      },
    });

    await generateResponse(
      { db: makeFakeDb(), ghl: makeGhl(), llm, defaultLlmModel: 'fake-model' },
      fakeSalon,
      'conv-1',
    );

    const held = vi
      .mocked(eventsRepo.insert)
      .mock.calls.filter((c) => c[2] === 'escalation_held');
    expect(held).toHaveLength(1);
    expect(held[0][3]).toEqual({ reason: 'client_refused_consultation_path' });
  });

  it('escalates the second consultation pushback', async () => {
    vi.mocked(eventsRepo.heldEscalationCount).mockResolvedValue(1);
    vi.mocked(conversationsRepo.loadContext).mockResolvedValue(
      makeCtx('just tell me yes or no, can you fix box dye gone wrong or not'),
    );
    const llm = new FakeLlmClient();
    llm.stage({
      match: () => true,
      output: {
        text: 'let me grab renata, she can give you a straight answer on this',
        toolCalls: [{ name: 'escalate_to_owner', arguments: { reason: 'client_refused_consultation_path' } }],
      },
    });
    const ghl = makeGhl();

    const result = await generateResponse(
      { db: makeFakeDb(), ghl, llm, defaultLlmModel: 'fake-model' },
      fakeSalon,
      'conv-1',
    );

    expect(vi.mocked(ghl.addTag)).toHaveBeenCalledWith('contact-1', ['escalation_active']);
    expect(vi.mocked(escalationsRepo.upsertActive)).toHaveBeenCalled();
    // Paused, so a re-drive would be dropped.
    expect(result.latestInboundAt).toBeNull();
    // And it must not hold a second time.
    expect(vi.mocked(eventsRepo.insert).mock.calls.filter((c) => c[2] === 'escalation_held')).toHaveLength(0);
  });

  it('scopes the counter to this conversation and this reason', async () => {
    vi.mocked(conversationsRepo.loadContext).mockResolvedValue(makeCtx('hi'));
    const llm = new FakeLlmClient();
    llm.stage({ match: () => true, output: { text: 'hey! what are you after for your hair?', toolCalls: [] } });

    await generateResponse(
      { db: makeFakeDb(), ghl: makeGhl(), llm, defaultLlmModel: 'fake-model' },
      fakeSalon,
      'conv-1',
    );

    expect(vi.mocked(eventsRepo.heldEscalationCount)).toHaveBeenCalledWith(
      expect.anything(),
      'conv-1',
      'client_refused_consultation_path',
    );
  });

  /**
   * The hold has to apply to whatever the retry decides, not only to a first
   * attempt. A retry that asks to hand over on the client's first pushback is the
   * same failure arriving one attempt later.
   */
  it('holds a pushback the corrective retry asks for', async () => {
    vi.mocked(eventsRepo.heldEscalationCount).mockResolvedValue(0);
    vi.mocked(conversationsRepo.loadContext).mockResolvedValue(makeCtx('i cant come in just to talk'));
    const llm = new FakeLlmClient();
    let n = 0;
    llm.stage({
      match: () => n++ === 0,
      output: { text: '', toolCalls: [] },
    });
    llm.stage({
      match: () => true,
      output: {
        text: 'the consult is quick and it fits around your day',
        toolCalls: [{ name: 'escalate_to_owner', arguments: { reason: 'client_refused_consultation_path' } }],
      },
    });
    const ghl = makeGhl();

    await generateResponse(
      { db: makeFakeDb(), ghl, llm, defaultLlmModel: 'fake-model' },
      fakeSalon,
      'conv-1',
    );

    expect(vi.mocked(ghl.sendMessage)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(ghl.addTag)).not.toHaveBeenCalled();
    expect(vi.mocked(eventsRepo.insert).mock.calls.filter((c) => c[2] === 'escalation_held')).toHaveLength(1);
  });

  /**
   * A KNOWN GAP, pinned so nobody reads the threshold as watertight.
   *
   * The counter governs the reason the model sends. If the model writes a handoff
   * sentence and fires no tool at all, the safety net manufactures
   * implied_handoff_no_tool_call, which is not governed and escalates on turn one.
   * Round 5's T1 and T5 are that same net firing. Closing this needs the reply
   * text corrected rather than the escalation dropped, because dropping it leaves
   * the client promised someone who never arrives.
   */
  it('still escalates a handoff sentence with no tool call, which the counter does not govern', async () => {
    vi.mocked(eventsRepo.heldEscalationCount).mockResolvedValue(0);
    vi.mocked(conversationsRepo.loadContext).mockResolvedValue(makeCtx('i literally cannot come in just to talk'));
    const llm = new FakeLlmClient();
    llm.stage({
      match: () => true,
      output: { text: "no worries! i'll get renata to give you a direct answer", toolCalls: [] },
    });
    const ghl = makeGhl();

    await generateResponse(
      { db: makeFakeDb(), ghl, llm, defaultLlmModel: 'fake-model' },
      fakeSalon,
      'conv-1',
    );

    expect(vi.mocked(ghl.addTag)).toHaveBeenCalledWith('contact-1', ['escalation_active']);
  });

  // The counter must never delay a reason that has nothing to do with the consult,
  // even on a turn where the client is also being blunt about wanting an answer.
  it('does not hold a refund, whatever the consultation counter says', async () => {
    vi.mocked(eventsRepo.heldEscalationCount).mockResolvedValue(0);
    vi.mocked(conversationsRepo.loadContext).mockResolvedValue(
      makeCtx('just tell me yes or no, am i getting a refund'),
    );
    const llm = new FakeLlmClient();
    llm.stage({
      match: () => true,
      output: {
        text: 'let me get renata on this for you',
        toolCalls: [{ name: 'escalate_to_owner', arguments: { reason: 'refund_request' } }],
      },
    });
    const ghl = makeGhl();

    await generateResponse({ db: makeFakeDb(), ghl, llm, defaultLlmModel: 'fake-model' }, fakeSalon, 'conv-1');

    expect(vi.mocked(ghl.addTag)).toHaveBeenCalledWith('contact-1', ['escalation_active']);
  });

  /**
   * The B6 drain had no test of any kind until now, which is how a notify-only
   * escalation came to hand back a null watermark and stay unnoticed. Round 5's T1
   * asks for a lead notification AND the bot answering the next message; those are
   * one requirement, because both need this drain to run.
   */
  it('hands the watermark back after a notify-only escalation, so the B6 drain still runs', async () => {
    vi.mocked(conversationsRepo.loadContext).mockResolvedValue(makeCtx('can you fix this'));
    const llm = new FakeLlmClient();
    llm.stage({
      match: () => true,
      output: {
        text: 'renata handles colour corrections, a consultation is the way in',
        toolCalls: [{ name: 'escalate_to_owner', arguments: { reason: 'correction_lead' } }],
      },
    });
    const ghl = makeGhl();

    const result = await generateResponse(
      { db: makeFakeDb(), ghl, llm, defaultLlmModel: 'fake-model' },
      fakeSalon,
      'conv-1',
    );

    // Owner told, bot still live, watermark returned so the worker can re-drive.
    // This is Round 5's T1 in full: a lead notification instead of the paused
    // handoff it fired, and the follow-up message still gets answered.
    expect(vi.mocked(ghl.addTag)).toHaveBeenCalledWith('contact-1', ['owner_fyi']);
    expect(vi.mocked(escalationsRepo.upsertActive)).not.toHaveBeenCalled();
    expect(vi.mocked(conversationsRepo.setHandoffUntil)).not.toHaveBeenCalled();
    expect(result.latestInboundAt).not.toBeNull();
  });

  it('returns a null watermark after a pausing escalation, because a re-drive would be dropped', async () => {
    vi.mocked(conversationsRepo.loadContext).mockResolvedValue(makeCtx('i want a refund please'));
    const llm = new FakeLlmClient();
    llm.stage({
      match: () => true,
      output: {
        text: 'let me get renata on this for you',
        toolCalls: [{ name: 'escalate_to_owner', arguments: { reason: 'refund_request' } }],
      },
    });
    const ghl = makeGhl();

    const result = await generateResponse(
      { db: makeFakeDb(), ghl, llm, defaultLlmModel: 'fake-model' },
      fakeSalon,
      'conv-1',
    );

    expect(vi.mocked(ghl.addTag)).toHaveBeenCalledWith('contact-1', ['escalation_active']);
    expect(result.latestInboundAt).toBeNull();
  });

  /**
   * The duplicate notification the owner saw on 2026-08-31 came from here: the
   * backend notifies the moment a voice note lands, and the model then escalated a
   * stale reason on the same turn, so she was pinged twice about one message.
   */
  it('drops an escalation signalled on a turn where the client sent nothing readable', async () => {
    vi.mocked(conversationsRepo.loadContext).mockResolvedValue({
      ...makeCtx('ignored'),
      recentMessages: [
        {
          ...makeCtx('ignored').recentMessages[0],
          textContent: null,
          channelType: 'image',
          rawContent: { attachments: [{ type: 'audio', url: 'https://x.test/v.mp4' }] },
        },
      ],
    });
    const llm = new FakeLlmClient();
    llm.stage({
      match: () => true,
      output: {
        text: "tell me what you're hoping to achieve with your hair and we can get you sorted",
        // Production fired client_refused_consultation_path here, but the
        // two-strike guard would now drop that one on its own and the test would
        // pass without exercising the suppression it is named after.
        toolCalls: [{ name: 'escalate_to_owner', arguments: { reason: 'unanswered_question' } }],
      },
    });
    const ghl = makeGhl();

    await generateResponse({ db: makeFakeDb(), ghl, llm, defaultLlmModel: 'fake-model' }, fakeSalon, 'conv-1');

    // The reply still goes out; only the stale escalation is dropped.
    expect(vi.mocked(ghl.sendMessage)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(escalationsRepo.upsertActive)).not.toHaveBeenCalled();
    expect(vi.mocked(eventsRepo.insert)).not.toHaveBeenCalledWith(
      expect.anything(),
      'conv-1',
      'escalated_to_owner',
      expect.anything(),
    );
  });

  /**
   * The safety direction. containsHandoffPromise was built to catch a promise made
   * WITHOUT a tool call, so it is tuned to avoid false positives; a MISS here would
   * drop a pause that should have stood. The reasons where that matters most are
   * therefore taken out of its hands: they pause on the reason alone.
   */
  it('a refund pauses even when the reply text trips no handoff pattern', async () => {
    vi.mocked(conversationsRepo.loadContext).mockResolvedValue(makeCtx('i want a refund'));
    const llm = new FakeLlmClient();
    llm.stage({
      // Deliberately worded so no handoff pattern matches it.
      match: () => true,
      output: {
        text: 'so sorry about that, we will sort it out for you today',
        toolCalls: [{ name: 'escalate_to_owner', arguments: { reason: 'refund_request' } }],
      },
    });
    const ghl = makeGhl();

    await generateResponse({ db: makeFakeDb(), ghl, llm, defaultLlmModel: 'fake-model' }, fakeSalon, 'conv-1');

    expect(vi.mocked(escalationsRepo.upsertActive)).toHaveBeenCalledWith(
      expect.anything(),
      'conv-1',
      'refund_request',
      null,
    );
  });

  it('escalation intent + empty on BOTH attempts falls back to the canned line, keeping the ORIGINAL reason', async () => {
    vi.mocked(conversationsRepo.loadContext).mockResolvedValue(makeCtx('i want a refund'));
    const llm = new FakeLlmClient();
    llm.stage({
      match: () => true,
      output: { text: '', toolCalls: [{ name: 'escalate_to_owner', arguments: { reason: 'refund_request' } }] },
    });
    const ghl = makeGhl();

    await generateResponse({ db: makeFakeDb(), ghl, llm, defaultLlmModel: 'fake-model' }, fakeSalon, 'conv-1');

    expect(llm.calls).toHaveLength(2);
    const sent = vi.mocked(ghl.sendMessage).mock.calls.map((c) => c[0].message);
    expect(sent[0]).toContain('let me grab Renata');
    // Crucially NOT relabelled as sanitizer_empty_output.
    expect(vi.mocked(escalationsRepo.upsertActive)).toHaveBeenCalledWith(expect.anything(), 'conv-1', 'refund_request', null);
  });

  // ── 1.9 tripwire: internal-vocabulary / machinery-narration net ──────────────

  it('reply that leaks internal machinery is REGENERATED; the clean retry is sent, tagged internal_vocab_leak_retried', async () => {
    vi.mocked(conversationsRepo.loadContext).mockResolvedValue(makeCtx('how much for balayage?'));
    const llm = new FakeLlmClient();
    let n = 0;
    // First reply narrates plumbing to the client; second is clean.
    llm.stage({
      match: () => n++ === 0,
      output: { text: "balayage starts around $220 🤍 I'll note this as the last quoted service", toolCalls: [] },
    });
    llm.stage({ match: () => true, output: { text: 'balayage starts around $220 🤍', toolCalls: [] } });
    const ghl = makeGhl();

    await generateResponse({ db: makeFakeDb(), ghl, llm, defaultLlmModel: 'fake-model' }, fakeSalon, 'conv-1');

    expect(llm.calls).toHaveLength(2); // leak -> regenerate
    const sent = vi.mocked(ghl.sendMessage).mock.calls.map((c) => c[0].message);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toBe('balayage starts around $220 🤍');
    expect(sent[0]).not.toContain('note this'); // machinery never reached the client
    expect(vi.mocked(escalationsRepo.upsertActive)).not.toHaveBeenCalled();
    // Recovered-by-retry leak is still queryable in sanitize_mods.
    const outMods = vi.mocked(messagesRepo.insertOutbound).mock.calls[0][1].sanitizeMods;
    expect(outMods).toContain('internal_vocab_leak_retried');
  });

  it('leak that SURVIVES the retry is discarded: reassurance line is sent + escalation reason internal_vocab_leak', async () => {
    vi.mocked(conversationsRepo.loadContext).mockResolvedValue(makeCtx('how much for balayage?'));
    const llm = new FakeLlmClient();
    // Both attempts narrate machinery — the model is malfunctioning this turn.
    llm.stage({ match: () => true, output: { text: "sure 🤍 let me flag her for the owner and mark_link_sent", toolCalls: [] } });
    const ghl = makeGhl();

    await generateResponse({ db: makeFakeDb(), ghl, llm, defaultLlmModel: 'fake-model' }, fakeSalon, 'conv-1');

    expect(llm.calls).toHaveLength(2); // original + one retry, both leak
    const sent = vi.mocked(ghl.sendMessage).mock.calls.map((c) => c[0].message);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('let me grab Renata'); // clean reassurance, not the leaky text
    expect(sent[0]).not.toContain('flag her');
    expect(vi.mocked(escalationsRepo.upsertActive)).toHaveBeenCalledWith(
      expect.anything(),
      'conv-1',
      'internal_vocab_leak',
      null,
    );
  });

  // ── B4: empty text on a ready-to-book message ────────────────────────────────

  it('empty output triggers a CORRECTIVE retry; the model then writes a real reply (any phrasing, no keyword needed)', async () => {
    vi.mocked(conversationsRepo.loadContext).mockResolvedValue(makeCtx('yep count me in for saturday'));
    const llm = new FakeLlmClient();
    let n = 0;
    llm.stage({
      match: () => n++ === 0,
      output: { text: '', toolCalls: [{ name: 'set_state_flag', arguments: { key: 'client_is_hesitant', value: false } }] },
    });
    llm.stage({ match: () => true, output: { text: 'yay 🤍 grab a time in the link above, cannot wait to get you in!', toolCalls: [] } });
    const ghl = makeGhl();

    await generateResponse({ db: makeFakeDb(), ghl, llm, defaultLlmModel: 'fake-model' }, fakeSalon, 'conv-1');

    expect(llm.calls).toHaveLength(2); // corrective retry
    // The retry carried the corrective nudge AND dropped native tools so the model
    // was forced to write text.
    const retryMessages = llm.calls[1].messages;
    expect(JSON.stringify(retryMessages)).toContain('in plain words');
    expect(llm.calls[1].tools).toEqual([]); // tools dropped on the corrective retry
    const sent = vi.mocked(ghl.sendMessage).mock.calls.map((c) => c[0].message);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('grab a time'); // the model's natural reply, not a canned fallback
    expect(vi.mocked(escalationsRepo.upsertActive)).not.toHaveBeenCalled();
  });

  it('B4 last-resort net: "book me in" empty on BOTH attempts sends the LINK, not an escalation', async () => {
    vi.mocked(conversationsRepo.loadContext).mockResolvedValue(makeCtx('You know what, im ready, book me in'));
    const llm = new FakeLlmClient();
    // Empty on both the initial call and the corrective retry (rare double-empty).
    llm.stage({
      match: () => true,
      output: { text: '', toolCalls: [{ name: 'set_state_flag', arguments: { key: 'client_is_hesitant', value: false } }] },
    });
    const ghl = makeGhl();

    await generateResponse({ db: makeFakeDb(), ghl, llm, defaultLlmModel: 'fake-model' }, fakeSalon, 'conv-1');

    expect(llm.calls).toHaveLength(2); // corrective retry, then the booking-intent net
    const sent = vi.mocked(ghl.sendMessage).mock.calls.map((c) => c[0].message);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('https://lumenhairstudio.glossgenius.com/book');
    expect(vi.mocked(escalationsRepo.upsertActive)).not.toHaveBeenCalled();
  });

  // ── llm_failed: no silence, no alert storm, no pointless retries ────────────

  /** An LlmClient whose every call throws `error`, counting attempts. */
  function makeFailingLlm(error: unknown) {
    const calls: number[] = [];
    return {
      calls,
      complete: vi.fn(async () => {
        calls.push(1);
        throw error;
      }),
    } as never;
  }

  it('llm_failed sends the client a reassurance line instead of silence, then escalates', async () => {
    vi.mocked(conversationsRepo.loadContext).mockResolvedValue(makeCtx('hey, quick question'));
    const llm = makeFailingLlm(new Error('socket hang up')); // transient -> retried
    const ghl = makeGhl();

    await generateResponse({ db: makeFakeDb(), ghl, llm, defaultLlmModel: 'fake-model' }, fakeSalon, 'conv-1');

    const sent = vi.mocked(ghl.sendMessage).mock.calls.map((c) => c[0].message);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('let me grab Renata'); // client is never left in silence
    expect(vi.mocked(escalationsRepo.upsertActive)).toHaveBeenCalledWith(
      expect.anything(),
      'conv-1',
      'llm_failed',
      null,
    );
  });

  it('does NOT retry a deterministic failure (exhausted quota) — one attempt, not three', async () => {
    vi.mocked(conversationsRepo.loadContext).mockResolvedValue(makeCtx('can i get a balayage'));
    const quotaError = Object.assign(new Error('You exceeded your current quota'), {
      status: 429,
      code: 'insufficient_quota',
    });
    const llm = makeFailingLlm(quotaError);
    const ghl = makeGhl();

    await generateResponse({ db: makeFakeDb(), ghl, llm, defaultLlmModel: 'fake-model' }, fakeSalon, 'conv-1');

    expect((llm as unknown as { calls: number[] }).calls).toHaveLength(1);
    expect(vi.mocked(escalationsRepo.upsertActive)).toHaveBeenCalledWith(
      expect.anything(),
      'conv-1',
      'llm_failed',
      null,
    );
  });

  it('still retries a transient failure three times before giving up', async () => {
    vi.mocked(conversationsRepo.loadContext).mockResolvedValue(makeCtx('hi'));
    const llm = makeFailingLlm(Object.assign(new Error('bad gateway'), { status: 502 }));
    const ghl = makeGhl();

    await generateResponse({ db: makeFakeDb(), ghl, llm, defaultLlmModel: 'fake-model' }, fakeSalon, 'conv-1');

    expect((llm as unknown as { calls: number[] }).calls).toHaveLength(3);
  });

  // Production 2026-08-08 and 2026-08-10 (QA Round 3, item 3.1): the first call
  // returned tool calls with no prose, the corrective retry 429'd on the
  // tokens-per-minute limit, and a healthy conversation was stamped `llm_failed`
  // and frozen for four hours. A retry failing is not an outage — the model
  // already answered once this turn.
  it('a retry failure is NOT reported as an outage: the first attempt\'s reason is kept', async () => {
    vi.mocked(conversationsRepo.loadContext).mockResolvedValue(makeCtx('i want a refund'));
    const llm = {
      calls: [] as unknown[],
      complete: vi.fn(async (input: unknown) => {
        (llm.calls as unknown[]).push(input);
        if (llm.calls.length === 1) {
          // Hand-rolled rather than staged through FakeLlmClient because the
          // second call has to throw, so this one spells the reply object out.
          const parsed = {
            reply: '',
            escalation_reason: 'refund_request',
            escalation_context: null,
            state_flag_key: null,
            state_flag_value: null,
          };
          return {
            text: JSON.stringify(parsed),
            toolCalls: [],
            parsed,
            usage: { inputTokens: 18484, outputTokens: 52 },
          };
        }
        throw Object.assign(new Error('Rate limit reached'), { status: 429 });
      }),
    } as never;
    const ghl = makeGhl();

    await generateResponse({ db: makeFakeDb(), ghl, llm, defaultLlmModel: 'fake-model' }, fakeSalon, 'conv-1');

    const sent = vi.mocked(ghl.sendMessage).mock.calls.map((c) => c[0].message);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('let me grab Renata');
    // The refund reason survives; it must NOT be relabelled llm_failed.
    expect(vi.mocked(escalationsRepo.upsertActive)).toHaveBeenCalledWith(
      expect.anything(),
      'conv-1',
      'refund_request',
      null,
    );
    expect(vi.mocked(escalationsRepo.upsertActive)).not.toHaveBeenCalledWith(
      expect.anything(),
      'conv-1',
      'llm_failed',
      null,
    );
  });

  it('a retry failure with no intent escalates as sanitizer_empty_output, never llm_failed', async () => {
    vi.mocked(conversationsRepo.loadContext).mockResolvedValue(makeCtx('what do you think?'));
    let n = 0;
    const llm = {
      complete: vi.fn(async () => {
        if (n++ === 0) return { text: '', toolCalls: [], usage: { inputTokens: 13000, outputTokens: 5 } };
        throw Object.assign(new Error('Rate limit reached'), { status: 429 });
      }),
    } as never;
    const ghl = makeGhl();

    await generateResponse({ db: makeFakeDb(), ghl, llm, defaultLlmModel: 'fake-model' }, fakeSalon, 'conv-1');

    expect(vi.mocked(escalationsRepo.upsertActive)).toHaveBeenCalledWith(
      expect.anything(),
      'conv-1',
      'sanitizer_empty_output',
      null,
    );
  });

  it('a failure on the FIRST call is still a genuine outage: llm_failed', async () => {
    vi.mocked(conversationsRepo.loadContext).mockResolvedValue(makeCtx('hey'));
    const llm = makeFailingLlm(Object.assign(new Error('bad gateway'), { status: 502 }));
    const ghl = makeGhl();

    await generateResponse({ db: makeFakeDb(), ghl, llm, defaultLlmModel: 'fake-model' }, fakeSalon, 'conv-1');

    expect(vi.mocked(escalationsRepo.upsertActive)).toHaveBeenCalledWith(
      expect.anything(),
      'conv-1',
      'llm_failed',
      null,
    );
  });

  it('dedups the alert storm: a repeat llm_failed inside the window is silent, no second escalation', async () => {
    vi.mocked(conversationsRepo.loadContext).mockResolvedValue(makeCtx('hey, quick question'));
    vi.mocked(eventsRepo.recentEscalationWithReason).mockResolvedValue(true); // owner already alerted
    const llm = makeFailingLlm(new Error('socket hang up'));
    const ghl = makeGhl();

    await generateResponse({ db: makeFakeDb(), ghl, llm, defaultLlmModel: 'fake-model' }, fakeSalon, 'conv-1');

    expect(ghl.sendMessage).not.toHaveBeenCalled(); // no repeated reassurance either
    expect(vi.mocked(escalationsRepo.upsertActive)).not.toHaveBeenCalled();
  });

  it('empty text on a NON-booking message still escalates — no stray booking link', async () => {
    vi.mocked(conversationsRepo.loadContext).mockResolvedValue(makeCtx('what time do you close on saturday?'));
    const llm = new FakeLlmClient();
    llm.stage({ match: () => true, output: { text: '', toolCalls: [] } });
    const ghl = makeGhl();

    await generateResponse({ db: makeFakeDb(), ghl, llm, defaultLlmModel: 'fake-model' }, fakeSalon, 'conv-1');

    expect(llm.calls).toHaveLength(2); // no booking intent -> retry, then escalate
    const sent = vi.mocked(ghl.sendMessage).mock.calls.map((c) => c[0].message);
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toContain('glossgenius.com/book'); // the concern: NO stray link
    expect(sent[0]).toContain('let me grab Renata');
    expect(vi.mocked(escalationsRepo.upsertActive)).toHaveBeenCalledWith(
      expect.anything(),
      'conv-1',
      'sanitizer_empty_output',
      null,
    );
  });
});
