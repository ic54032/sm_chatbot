import { describe, it, expect } from 'vitest';
import { buildPrompt } from '../../../src/prompt/build.js';
import type { Salon, ConversationContext } from '../../../src/core/types.js';
import type { ProcessedImage } from '../../../src/images/process.js';

function makeSalon(): Salon {
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
    } as Salon['config'],
    isActive: true,
  };
}

function makeMsg(id: string, direction: 'inbound' | 'outbound', text: string | null): ConversationContext['recentMessages'][number] {
  return {
    id,
    conversationId: 'c1',
    direction,
    channelType: 'text',
    textContent: text,
    aiRawOutput: null,
    sanitizeMods: null,
    ghlMessageId: null,
    createdAt: new Date(),
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
