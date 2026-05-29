import { describe, it, expect, vi } from 'vitest';
import { sendCannedReassurance } from '../../../src/core/canned-messages.js';
import type { GhlClient } from '../../../src/ghl/client.js';
import type { Salon, Conversation } from '../../../src/core/types.js';

function makeSalon(): Salon {
  return {
    id: 's1',
    displayName: 'Test',
    ghlLocationId: 'loc1',
    ghlPit: 'pit',
    sourceOfTruth: { salon_basics: { owner_first_name: 'Sarah', salon_name: 'Test' }, booking: { url: 'https://book.test/x' }, price_quoting_policy: 'b' } as Salon['sourceOfTruth'],
    config: {} as Salon['config'],
    isActive: true,
  };
}

function makeConversation(): Conversation {
  return {
    id: 'c1',
    salonId: 's1',
    ghlContactId: 'gc1',
    ghlConversationId: null,
    clientHandle: null,
    state: {},
    handoffUntil: null,
    lastMessageAt: null,
  };
}

describe('sendCannedReassurance', () => {
  it('sends message via GHL and persists outbound row', async () => {
    const sendMessage = vi.fn(async () => ({ ghlMessageId: 'm1' }));
    const insertOutbound = vi.fn(async () => undefined);
    const ghl = { sendMessage } as unknown as GhlClient;
    const db = {} as never;

    await sendCannedReassurance(
      { db, ghl, messagesRepo: { insertOutbound } },
      makeSalon(),
      makeConversation(),
      'let me grab Sarah for you',
    );

    expect(sendMessage).toHaveBeenCalledWith({
      contactId: 'gc1',
      type: 'IG',
      message: 'let me grab Sarah for you',
    });
    expect(insertOutbound).toHaveBeenCalledOnce();
    const inserted = insertOutbound.mock.calls[0][1] as {
      textContent: string;
      sanitizeMods: string[] | null;
      ghlMessageId: string;
    };
    expect(inserted.textContent).toBe('let me grab Sarah for you');
    expect(inserted.sanitizeMods).toEqual(['canned_reassurance']);
    expect(inserted.ghlMessageId).toBe('m1');
  });

  it('propagates ghl.sendMessage errors (caller handles)', async () => {
    const sendMessage = vi.fn(async () => {
      throw new Error('outside window');
    });
    const insertOutbound = vi.fn();
    const ghl = { sendMessage } as unknown as GhlClient;
    const db = {} as never;

    await expect(
      sendCannedReassurance(
        { db, ghl, messagesRepo: { insertOutbound } },
        makeSalon(),
        makeConversation(),
        'msg',
      ),
    ).rejects.toThrow('outside window');
    expect(insertOutbound).not.toHaveBeenCalled();
  });
});
