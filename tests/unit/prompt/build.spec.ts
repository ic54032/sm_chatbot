import { describe, it, expect } from 'vitest';
import { buildPrompt } from '../../../src/prompt/build.js';
import type { Salon, ConversationContext } from '../../../src/core/types.js';
import type { ProcessedImage } from '../../../src/images/process.js';

function makeSalon(configOverrides: Record<string, unknown> = {}): Salon {
  return {
    id: 's1',
    displayName: 'Test',
    ghlLocationId: 'loc',
    ghlPit: 'pit',
    sourceOfTruth: {
      salon_basics: {
        salon_name: 'Test Salon',
        owner_first_name: 'Renata',
      },
      booking: {
        url: 'https://book.test/x',
      },
      price_quoting_policy: 'b',
    } as Salon['sourceOfTruth'],
    config: {
      max_words_per_message: 40,
      max_emojis: 2,
      booking_link_dedup_window_hours: 3,
      response_delay_ms: 40_000,
      handoff_window_hours: 4,
      ghl_custom_field_ids: { needs_owner_attention: 'a', bot_paused_until: 'b', last_escalation_reason: 'c' },
      image_processing: { enabled: true, max_dimension: 1280, jpeg_quality: 80 },
      ...configOverrides,
    } as Salon['config'],
    isActive: true,
  };
}

function makeMsg(id: string, direction: 'inbound' | 'outbound', text: string | null, createdAt: Date = new Date()): ConversationContext['recentMessages'][number] {
  return {
    id,
    conversationId: 'c1',
    direction,
    channelType: 'text',
    textContent: text,
    aiRawOutput: null,
    sanitizeMods: null,
    ghlMessageId: null,
    createdAt,
    rawContent: null,
  };
}

const baseCtx = (msgs: ConversationContext['recentMessages']): ConversationContext => ({
  conversation: {
    id: 'c1',
    salonId: 's1',
    ghlContactId: 'gc1',
    ghlConversationId: null,
    clientHandle: null,
    state: {},
    handoffUntil: null,
    lastMessageAt: null,
  },
  recentMessages: msgs,
  recentEvents: [],
});

const img: ProcessedImage = {
  base64: 'AAAA',
  mediaType: 'image/jpeg',
  width: 800,
  height: 600,
  bytesIn: 1000,
  bytesOut: 500,
};

describe('buildPrompt multimodal output', () => {
  it('returns string content for messages without images', () => {
    const ctx = baseCtx([makeMsg('m1', 'inbound', 'hello')]);
    const result = buildPrompt({ salon: makeSalon(), ctx, bookingLinkRecentlySent: false, imagesByMessageId: new Map() });
    expect(result.messages[0]).toEqual({ role: 'user', content: 'hello' });
  });

  it('returns ContentBlock[] with image+text when inbound has image', () => {
    const ctx = baseCtx([makeMsg('m1', 'inbound', 'look at this')]);
    const imgs = new Map();
    imgs.set('m1', [img]);
    const result = buildPrompt({ salon: makeSalon(), ctx, bookingLinkRecentlySent: false, imagesByMessageId: imgs });
    expect(result.messages[0]).toEqual({
      role: 'user',
      content: [
        { type: 'image', mediaType: 'image/jpeg', base64: 'AAAA' },
        { type: 'text', text: 'look at this' },
      ],
    });
  });

  it('uses placeholder text when inbound has image but no caption', () => {
    const ctx = baseCtx([makeMsg('m1', 'inbound', null)]);
    const imgs = new Map();
    imgs.set('m1', [img]);
    const result = buildPrompt({ salon: makeSalon(), ctx, bookingLinkRecentlySent: false, imagesByMessageId: imgs });
    expect(result.messages[0]).toEqual({
      role: 'user',
      content: [
        { type: 'image', mediaType: 'image/jpeg', base64: 'AAAA' },
        { type: 'text', text: '[image only, no caption]' },
      ],
    });
  });

  it('injects the [no image in this message, invite them to send it again] marker for an unviewable image, keeping the caption (B3)', () => {
    const ctx = baseCtx([makeMsg('m1', 'inbound', 'can you fix this?')]);
    const result = buildPrompt({
      salon: makeSalon(),
      ctx,
      bookingLinkRecentlySent: false,
      imagesByMessageId: new Map(), // fetch failed, no processed image
      unviewableImageMessageIds: new Set(['m1']),
    });
    expect(result.messages[0]).toEqual({ role: 'user', content: 'can you fix this? [no image in this message, invite them to send it again]' });
  });

  it('marks a captionless unviewable image with just the marker', () => {
    const ctx = baseCtx([makeMsg('m1', 'inbound', null)]);
    const result = buildPrompt({
      salon: makeSalon(),
      ctx,
      bookingLinkRecentlySent: false,
      imagesByMessageId: new Map(),
      unviewableImageMessageIds: new Set(['m1']),
    });
    expect(result.messages[0]).toEqual({ role: 'user', content: '[no image in this message, invite them to send it again]' });
  });

  it('includes multiple image blocks before text', () => {
    const ctx = baseCtx([makeMsg('m1', 'inbound', 'three views')]);
    const imgs = new Map();
    imgs.set('m1', [img, img, img]);
    const result = buildPrompt({ salon: makeSalon(), ctx, bookingLinkRecentlySent: false, imagesByMessageId: imgs });
    const content = result.messages[0].content as Array<{ type: string }>;
    expect(content).toHaveLength(4);
    expect(content.slice(0, 3).every((b) => b.type === 'image')).toBe(true);
    expect(content[3].type).toBe('text');
  });

  it('only enriches inbound messages, not outbound', () => {
    const ctx = baseCtx([
      makeMsg('m1', 'inbound', 'q'),
      makeMsg('m2', 'outbound', 'a'),
    ]);
    const imgs = new Map();
    imgs.set('m2', [img]);  // attempt to attach image to outbound (should be ignored)
    const result = buildPrompt({ salon: makeSalon(), ctx, bookingLinkRecentlySent: false, imagesByMessageId: imgs });
    expect(result.messages[1]).toEqual({ role: 'assistant', content: 'a' });
  });

  it('system prompt contains the verbatim booking URL header', () => {
    const ctx = baseCtx([makeMsg('m1', 'inbound', 'hi')]);
    const result = buildPrompt({ salon: makeSalon(), ctx, bookingLinkRecentlySent: false, imagesByMessageId: new Map() });
    expect(result.systemPrompt).toContain('https://book.test/x');
    expect(result.systemPrompt).toContain('PASTE VERBATIM');
  });

  it('system prompt contains conversation state and knowledge base sections', () => {
    const ctx = baseCtx([makeMsg('m1', 'inbound', 'hi')]);
    const result = buildPrompt({ salon: makeSalon(), ctx, bookingLinkRecentlySent: false, imagesByMessageId: new Map() });
    expect(result.systemPrompt).toContain('# Conversation state');
    expect(result.systemPrompt).toContain('# Knowledge base');
    expect(result.systemPrompt).toContain('Total inbound messages this conversation: 1');
  });

  it('system prompt includes the master prompt body', () => {
    const ctx = baseCtx([makeMsg('m1', 'inbound', 'hi')]);
    const result = buildPrompt({ salon: makeSalon(), ctx, bookingLinkRecentlySent: false, imagesByMessageId: new Map() });
    expect(result.systemPrompt).toContain('IDENTITY AND VOICE');
  });
});

/**
 * The photo count is stated as a fact because four separate prompt rules failed
 * to stop the model inventing visual detail. With zero images in context it
 * praised "the vibe of that reel" and "that blend in the reel" (production
 * 2026-08-17), reaching back to a pasted link and a two-day-old photo. Each case
 * below is one of those failures, so a regression here is a regression in
 * client-visible behaviour.
 */
describe('buildPrompt photo visibility fact', () => {
  const line = (n: number) => `- Photos visible to you this turn: ${n}`;
  const build = (msgs: ConversationContext['recentMessages'], imgs: Map<string, ProcessedImage[]> = new Map()) =>
    buildPrompt({ salon: makeSalon(), ctx: baseCtx(msgs), bookingLinkRecentlySent: false, imagesByMessageId: imgs }).systemPrompt;

  it('reports 0 on a text-only turn', () => {
    expect(build([makeMsg('m1', 'inbound', 'could i pull this off?')])).toContain(line(0));
  });

  it('counts the photo attached to the current turn', () => {
    const imgs = new Map([['m1', [img]]]);
    expect(build([makeMsg('m1', 'inbound', 'like this?')], imgs)).toContain(line(1));
  });

  it('counts every photo in a multi-message burst since our last reply', () => {
    const msgs = [
      makeMsg('m1', 'outbound', 'hey! what were you thinking?'),
      makeMsg('m2', 'inbound', 'this one'),
      makeMsg('m3', 'inbound', 'and this'),
    ];
    const imgs = new Map([
      ['m2', [img]],
      ['m3', [img]],
    ]);
    expect(build(msgs, imgs)).toContain(line(2));
  });

  // The exact production failure: a photo two days back, our reply after it, then
  // a bare text question. Those pixels are NOT on this request, so claiming to see
  // them is a fabrication.
  it('does not count a photo that our own reply has already scrolled past', () => {
    const msgs = [
      makeMsg('m1', 'inbound', 'thoughts?'),
      makeMsg('m2', 'outbound', 'love the shape of that fringe'),
      makeMsg('m3', 'inbound', 'and how much would it be?'),
    ];
    const imgs = new Map([['m1', [img]]]);
    expect(build(msgs, imgs)).toContain(line(0));
  });

  // An owner turn is a real reply on the wire, so it ends the burst exactly like
  // an outbound one. Treating it as inbound would resurrect the bug during handoff.
  it('treats an owner reply as the end of the burst', () => {
    const owner = { ...makeMsg('m2', 'outbound', 'hi, renata here'), direction: 'owner' as const };
    const msgs = [makeMsg('m1', 'inbound', 'hi'), owner, makeMsg('m3', 'inbound', 'still there?')];
    const imgs = new Map([['m1', [img]]]);
    expect(build(msgs, imgs)).toContain(line(0));
  });

  it('reports 0 when a photo was sent but could not be opened', () => {
    // The pixels never arrived, so the model must ask for a resend rather than
    // describe them — same fact, different cause.
    const systemPrompt = buildPrompt({
      salon: makeSalon(),
      ctx: baseCtx([makeMsg('m1', 'inbound', 'like this')]),
      bookingLinkRecentlySent: false,
      imagesByMessageId: new Map(),
      unviewableImageMessageIds: new Set(['m1']),
    }).systemPrompt;
    expect(systemPrompt).toContain(line(0));
  });

  // "visible: 0" alone is ambiguous, and the two readings need opposite replies:
  // invite a photo that never arrived, but never ask a client to re-send one we
  // already described.
  it('separates photos never sent from photos already answered', () => {
    const earlier = (msgs: ConversationContext['recentMessages'], imgs: Map<string, ProcessedImage[]>) =>
      build(msgs, imgs).match(/- Photos earlier in this conversation, already answered: (\d+)/)?.[1];

    // Nothing ever arrived.
    expect(earlier([makeMsg('m1', 'inbound', 'could i pull this off?')], new Map())).toBe('0');

    // Photo, our reply, then a bare follow-up: visible 0, earlier 1.
    const followUp = [
      makeMsg('m1', 'inbound', 'thoughts?'),
      makeMsg('m2', 'outbound', 'love the shape of that fringe'),
      makeMsg('m3', 'inbound', 'could i pull this off?'),
    ];
    const imgs = new Map([['m1', [img]]]);
    expect(build(followUp, imgs)).toContain(line(0));
    expect(earlier(followUp, imgs)).toBe('1');
  });

  it('does not double-count the current turn as an earlier photo', () => {
    const imgs = new Map([['m1', [img]]]);
    const prompt = build([makeMsg('m1', 'inbound', 'like this?')], imgs);
    expect(prompt).toContain(line(1));
    expect(prompt).toContain('already answered: 0');
  });

  it('states the count as a fact the prompt body knows how to read', () => {
    // The state line and the rule that interprets it must agree on the wording,
    // the way the booking-link dedup line already does.
    expect(build([makeMsg('m1', 'inbound', 'hi')])).toContain('Photos visible to you this turn');
  });
});

/**
 * Three client messages arrived five seconds apart on 2026-08-23 18:24 asking how
 * long balayage takes, whether the salon takes card, and what parking is like.
 * All three reached the model in one request and the reply answered the first and
 * the last. Coalescing and the drain were both correct; nothing said the trailing
 * run is one burst in which every question still needs an answer.
 */
describe('buildPrompt burst size fact', () => {
  const waiting = (msgs: ConversationContext['recentMessages']) =>
    buildPrompt({ salon: makeSalon(), ctx: baseCtx(msgs), bookingLinkRecentlySent: false, imagesByMessageId: new Map() })
      .systemPrompt.match(/- Client messages waiting for this reply: (\d+)/)?.[1];

  it('counts a single message as 1', () => {
    expect(waiting([makeMsg('m1', 'inbound', 'hi')])).toBe('1');
  });

  it('counts the whole trailing run of a burst', () => {
    expect(
      waiting([
        makeMsg('m1', 'outbound', 'anything else?'),
        makeMsg('m2', 'inbound', 'how long does balayage take'),
        makeMsg('m3', 'inbound', 'do you take card'),
        makeMsg('m4', 'inbound', 'whats parking like'),
      ]),
    ).toBe('3');
  });

  it('resets after our own reply', () => {
    expect(
      waiting([
        makeMsg('m1', 'inbound', 'q1'),
        makeMsg('m2', 'inbound', 'q2'),
        makeMsg('m3', 'outbound', 'both answered'),
        makeMsg('m4', 'inbound', 'one more'),
      ]),
    ).toBe('1');
  });

  it('treats an owner message as the end of the burst, like an outbound one', () => {
    const owner = { ...makeMsg('m2', 'outbound', 'renata here'), direction: 'owner' as const };
    expect(waiting([makeMsg('m1', 'inbound', 'q1'), owner, makeMsg('m3', 'inbound', 'q2')])).toBe('1');
  });
});

/**
 * On Sunday 2026-08-23 at 11:24 Denver time the bot said "not today, but we'll be
 * open tomorrow from 10am to 7pm". The knowledge base has monday closed and
 * tuesday 10am to 7pm: it took one day's hours and attached them to another. Both
 * days are now stated outright so walking the week is not its job.
 */
describe('buildPrompt weekday hours facts', () => {
  const hoursSalon = () => {
    const salon = makeSalon({ timezone: 'America/Denver' });
    (salon.sourceOfTruth as unknown as { salon_basics: Record<string, unknown> }).salon_basics = {
      salon_name: 'Test Salon',
      owner_first_name: 'Renata',
      operating_hours: {
        monday: 'closed',
        tuesday: '10am to 7pm',
        wednesday: '10am to 7pm',
        thursday: '10am to 8pm',
        friday: '9am to 6pm',
        saturday: '9am to 5pm',
        sunday: 'closed',
      },
    };
    return salon;
  };

  const lines = () =>
    buildPrompt({
      salon: hoursSalon(),
      ctx: baseCtx([makeMsg('m1', 'inbound', 'are you open rn?')]),
      bookingLinkRecentlySent: false,
      imagesByMessageId: new Map(),
    }).stateLines;

  it('states today and tomorrow by weekday name', () => {
    const out = lines();
    const today = out.find((l) => l.startsWith('- Today ('));
    const tomorrow = out.find((l) => l.startsWith('- Tomorrow ('));
    expect(today).toBeDefined();
    expect(tomorrow).toBeDefined();
    // Whatever day the suite runs on, each line must name a real weekday and
    // carry that day's own value from the knowledge base.
    const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
    for (const line of [today!, tomorrow!]) {
      const day = /\((\w+)\)/.exec(line)?.[1];
      expect(days).toContain(day);
      expect(line).toContain(day === 'monday' || day === 'sunday' ? 'closed' : 'to');
    }
  });

  it('wraps from the last day of the week to the first', () => {
    // Sunday's tomorrow is monday, which is the pairing that produced the bug.
    const out = lines();
    const today = /\((\w+)\)/.exec(out.find((l) => l.startsWith('- Today ('))!)?.[1];
    const tomorrow = /\((\w+)\)/.exec(out.find((l) => l.startsWith('- Tomorrow ('))!)?.[1];
    const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
    expect(tomorrow).toBe(days[(days.indexOf(today!) + 1) % 7]);
  });

  it('omits both lines when the salon has no operating_hours', () => {
    const out = buildPrompt({
      salon: makeSalon({ timezone: 'America/Denver' }),
      ctx: baseCtx([makeMsg('m1', 'inbound', 'hi')]),
      bookingLinkRecentlySent: false,
      imagesByMessageId: new Map(),
    }).stateLines;
    expect(out.some((l) => l.startsWith('- Today ('))).toBe(false);
  });
});

describe('buildPrompt time awareness', () => {
  const hourMs = 3_600_000;

  it('includes salon-local datetime line when config.timezone is set', () => {
    const ctx = baseCtx([makeMsg('m1', 'inbound', 'hi')]);
    const salon = makeSalon({ timezone: 'America/Chicago' });
    const result = buildPrompt({ salon, ctx, bookingLinkRecentlySent: false, imagesByMessageId: new Map() });
    expect(result.systemPrompt).toMatch(/- Current date and time \(salon local\): \w+, \w+ \d{1,2}, \d{4}/);
  });

  // Note: the master prompt body itself mentions both line names in its Time
  // awareness section, so negative assertions must target the state-line
  // format ("- <name>: ") which only build.ts emits.
  it('omits the datetime line when timezone is not set', () => {
    const ctx = baseCtx([makeMsg('m1', 'inbound', 'hi')]);
    const result = buildPrompt({ salon: makeSalon(), ctx, bookingLinkRecentlySent: false, imagesByMessageId: new Map() });
    expect(result.systemPrompt).not.toContain('- Current date and time (salon local):');
  });

  it('omits the datetime line (without crashing) for an invalid timezone', () => {
    const ctx = baseCtx([makeMsg('m1', 'inbound', 'hi')]);
    const salon = makeSalon({ timezone: 'Not/AZone' });
    const result = buildPrompt({ salon, ctx, bookingLinkRecentlySent: false, imagesByMessageId: new Map() });
    expect(result.systemPrompt).not.toContain('- Current date and time (salon local):');
  });

  it('omits hours-since line for a brand new conversation (all inbound)', () => {
    const ctx = baseCtx([makeMsg('m1', 'inbound', 'hi')]);
    const result = buildPrompt({ salon: makeSalon(), ctx, bookingLinkRecentlySent: false, imagesByMessageId: new Map() });
    expect(result.systemPrompt).not.toContain('- Hours since last client message:');
  });

  it('reports the gap between the previous reply and the current client message', () => {
    const t0 = new Date('2026-07-01T10:00:00Z');
    const ctx = baseCtx([
      makeMsg('m1', 'inbound', 'hi', t0),
      makeMsg('m2', 'outbound', 'hello!', new Date(t0.getTime() + 1 * hourMs)),
      makeMsg('m3', 'inbound', 'back again', new Date(t0.getTime() + 49 * hourMs)),
    ]);
    const result = buildPrompt({ salon: makeSalon(), ctx, bookingLinkRecentlySent: false, imagesByMessageId: new Map() });
    expect(result.systemPrompt).toContain('- Hours since last client message: 48');
  });

  it('measures from the START of a batched inbound burst, not the last message in it', () => {
    const t0 = new Date('2026-07-01T10:00:00Z');
    const ctx = baseCtx([
      makeMsg('m1', 'inbound', 'hi', t0),
      makeMsg('m2', 'outbound', 'hello!', new Date(t0.getTime() + 1 * hourMs)),
      // Client returns after 24h with a rapid two-message burst.
      makeMsg('m3', 'inbound', 'hey', new Date(t0.getTime() + 25 * hourMs)),
      makeMsg('m4', 'inbound', 'you there?', new Date(t0.getTime() + 25 * hourMs + 9_000)),
    ]);
    const result = buildPrompt({ salon: makeSalon(), ctx, bookingLinkRecentlySent: false, imagesByMessageId: new Map() });
    expect(result.systemPrompt).toContain('- Hours since last client message: 24');
  });

  it('reports 0 hours for a continuing rapid exchange', () => {
    const t0 = new Date('2026-07-01T10:00:00Z');
    const ctx = baseCtx([
      makeMsg('m1', 'inbound', 'hi', t0),
      makeMsg('m2', 'outbound', 'hello!', new Date(t0.getTime() + 60_000)),
      makeMsg('m3', 'inbound', 'ok cool', new Date(t0.getTime() + 120_000)),
    ]);
    const result = buildPrompt({ salon: makeSalon(), ctx, bookingLinkRecentlySent: false, imagesByMessageId: new Map() });
    expect(result.systemPrompt).toContain('- Hours since last client message: 0');
  });

  // The llm_failed class of bug: a media-only row (text_content NULL) used to
  // render as { role:'user', content:'' }, which the OpenAI/Anthropic APIs
  // reject. Because the row stays in the loaded window, EVERY later call on that
  // conversation failed identically until it scrolled out.
  describe('never emits an empty content turn (API-invalid)', () => {
    const media = (
      id: string,
      atts: Array<{ type: string }>,
      text: string | null = null,
    ): ConversationContext['recentMessages'][number] => ({
      ...makeMsg(id, 'inbound', text),
      channelType: 'image',
      rawContent: { attachments: atts },
    });

    it('renders a video-only message as a marker, not an empty string', () => {
      const ctx = baseCtx([media('m1', [{ type: 'video' }]), makeMsg('m2', 'inbound', 'hey did you see it?')]);
      const result = buildPrompt({ salon: makeSalon(), ctx, bookingLinkRecentlySent: false, imagesByMessageId: new Map() });
      expect(result.messages[0].content).toBe('[no text in this message, ask what they are after]');
      expect(result.messages.every((m) => m.content !== '')).toBe(true);
    });

    it('renders a voice note and a dropped reel as their own markers', () => {
      const ctx = baseCtx([media('m1', [{ type: 'audio' }]), media('m2', [])]);
      const result = buildPrompt({ salon: makeSalon(), ctx, bookingLinkRecentlySent: false, imagesByMessageId: new Map() });
      expect(result.messages[0].content).toBe('[no text in this message, ask what they are after]');
      expect(result.messages[1].content).toBe('[no text in this message, ask what they are after]');
    });

    it('keeps a caption and appends the marker when both are present', () => {
      const ctx = baseCtx([media('m1', [{ type: 'video' }], 'can you do this?')]);
      const result = buildPrompt({ salon: makeSalon(), ctx, bookingLinkRecentlySent: false, imagesByMessageId: new Map() });
      expect(result.messages[0].content).toBe('can you do this? [no text in this message, ask what they are after]');
    });

    it('drops a genuinely empty turn entirely rather than emitting empty content', () => {
      const ctx = baseCtx([
        makeMsg('m1', 'inbound', null), // text channel, no text, no attachments
        makeMsg('m2', 'outbound', ''), // empty assistant turn
        makeMsg('m3', 'inbound', 'hello?'),
      ]);
      const result = buildPrompt({ salon: makeSalon(), ctx, bookingLinkRecentlySent: false, imagesByMessageId: new Map() });
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].content).toBe('hello?');
    });
  });
});
