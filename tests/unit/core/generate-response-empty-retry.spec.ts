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
