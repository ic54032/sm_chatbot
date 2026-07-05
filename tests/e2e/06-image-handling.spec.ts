import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDb, migrateTestDb, truncateAll } from '../helpers/test-db.js';
import { FakeLlmClient } from '../helpers/fake-llm-client.js';
import { buildTestApp } from '../helpers/test-app.js';
import * as salonsRepo from '../../src/db/repos/salons.js';

const fixturesDir = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures');
const imageFixturesDir = join(fileURLToPath(new URL('.', import.meta.url)), '../unit/images/fixtures');

describe('e2e #6 — image handling', () => {
  const db = createTestDb();
  let testApp: Awaited<ReturnType<typeof buildTestApp>>;
  let llm: FakeLlmClient;

  beforeAll(async () => {
    await migrateTestDb();
  });

  beforeEach(async () => {
    await truncateAll(db);
    llm = new FakeLlmClient();
    // Stub fetcher returns real JPEG bytes so processImageForVision works against the real sharp pipeline.
    const jpegBuffer = readFileSync(join(imageFixturesDir, 'small-800x600.jpg'));
    testApp = await buildTestApp(db, llm, {
      fetchAttachment: async () => jpegBuffer,
    });
    await testApp.queue.obliterate({ force: true });
  });

  afterEach(async () => {
    await testApp.shutdown();
  });

  afterAll(async () => {
    await db.destroy();
  });

  it('inbound with image attachment results in vision LLM call and outbound reply', async () => {
    const fixture = JSON.parse(readFileSync(join(fixturesDir, 'salon-lumen.json'), 'utf8'));
    const salon = await salonsRepo.create(db, {
      displayName: fixture.display_name,
      ghlLocationId: fixture.ghl_location_id,
      ghlPit: fixture.ghl_pit,
      sourceOfTruth: fixture.source_of_truth,
      config: fixture.config, // image_processing defaults applied via Zod (.default({}))
    });

    // Stage the GHL message so handle-inbound's getMessage() returns it with the image
    // attachment — this is what classifies the inbound as channel_type='image'.
    testApp.ghl.stageMessage('msg-img-1', 'check this length', [
      { url: 'https://x.test/img.jpg', type: 'image' },
    ]);

    // Stage LLM response — only matches when the user content is a ContentBlock[] containing an image block.
    // This is the load-bearing assertion: it verifies the worker actually injected the image into the LLM call.
    llm.stage({
      match: (input) => {
        const last = input.messages.at(-1);
        if (!last) return false;
        if (!Array.isArray(last.content)) return false;
        return last.content.some(
          (b) => typeof b === 'object' && b !== null && 'type' in b && b.type === 'image',
        );
      },
      output: { text: `love that 🤍 grab a consultation here ${fixture.source_of_truth.booking.url}` },
    });

    // POST to the real webhook (not dev-simulate) so we can include `attachments` inline.
    // Why this matters: handle-inbound stores `input.rawPayload` as messages.raw_content. The worker
    // later calls extractImageAttachments(rawContent) to find image URLs to fetch. The dev-simulate
    // route doesn't accept attachments, so we exercise the production webhook path here.
    const res = await testApp.app.inject({
      method: 'POST',
      url: '/webhooks/ghl/inbound',
      headers: { 'x-webhook-secret': 'test-secret' },
      payload: {
        location_id: salon.ghlLocationId,
        contact_id: 'c_img',
        message_id: 'msg-img-1',
        message_text: 'check this length',
        attachments: [{ type: 'image', url: 'https://x.test/img.jpg' }],
      },
    });
    expect(res.statusCode).toBe(200);

    await new Promise((r) => setTimeout(r, 2000));

    // Verify LLM was called with image content (the match callback only stages when an image block exists)
    expect(llm.calls).toHaveLength(1);
    const lastUserMsg = llm.calls[0].messages.at(-1);
    expect(Array.isArray(lastUserMsg?.content)).toBe(true);

    // Verify outbound message persisted
    const outbound = await db
      .selectFrom('messages')
      .where('direction', '=', 'outbound')
      .selectAll()
      .execute();
    expect(outbound).toHaveLength(1);
    expect(outbound[0].text_content).toContain('consultation');

    // Verify inbound persisted with channel_type='image'
    const inbound = await db
      .selectFrom('messages')
      .where('direction', '=', 'inbound')
      .selectAll()
      .execute();
    expect(inbound).toHaveLength(1);
    expect(inbound[0].channel_type).toBe('image');
  });

  it('inbound with video attachment escalates without LLM call', async () => {
    const fixture = JSON.parse(readFileSync(join(fixturesDir, 'salon-lumen.json'), 'utf8'));
    const salon = await salonsRepo.create(db, {
      displayName: fixture.display_name,
      ghlLocationId: fixture.ghl_location_id,
      ghlPit: fixture.ghl_pit,
      sourceOfTruth: fixture.source_of_truth,
      config: fixture.config,
    });

    // Stage GHL message with a video attachment — handle-inbound hard-escalates videos before
    // reaching the respond queue, so the worker (and LLM) never see this conversation.
    testApp.ghl.stageMessage('msg-vid-1', '', [
      { url: 'https://x.test/v.mp4', type: 'video' },
    ]);

    const res = await testApp.app.inject({
      method: 'POST',
      url: '/webhooks/ghl/inbound',
      headers: { 'x-webhook-secret': 'test-secret' },
      payload: {
        location_id: salon.ghlLocationId,
        contact_id: 'c_vid',
        message_id: 'msg-vid-1',
        attachments: [{ type: 'video', url: 'https://x.test/v.mp4' }],
      },
    });
    expect(res.statusCode).toBe(200);

    await new Promise((r) => setTimeout(r, 1500));

    // No LLM call — the hard-escalation prečac in handle-inbound short-circuits the respond queue.
    expect(llm.calls).toHaveLength(0);

    // Silent escalation: no reply goes to the client — the owner picks the
    // conversation up personally from the escalation notification.
    const log = await db.selectFrom('mock_outbound_log').selectAll().execute();
    expect(log).toHaveLength(0);

    // Escalation row exists with reason='video_attachment'
    const escalations = await db.selectFrom('escalations').selectAll().execute();
    expect(escalations).toHaveLength(1);
    expect(escalations[0].reason).toBe('video_attachment');

    // Conversation handoff_until is in the future
    const conversations = await db.selectFrom('conversations').selectAll().execute();
    expect(conversations).toHaveLength(1);
    expect(conversations[0].handoff_until).not.toBeNull();
    expect(new Date(conversations[0].handoff_until!).getTime()).toBeGreaterThan(Date.now());
  });
});
