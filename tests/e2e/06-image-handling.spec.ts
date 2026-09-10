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

  /**
   * Media tells the owner AND keeps the conversation running.
   *
   * This test used to assert the opposite — no LLM call, no reply, a handoff into
   * the future — which is what the code did until QA Round 3 item 4.6. Freezing a
   * conversation over an attachment cost leads and made the tag dishonest, because
   * it claimed a paused bot while the bot went on replying. Round 5 scored the
   * current behaviour as PASS on T6 and the report names it the shape T1 has to
   * copy, so the old assertions describe behaviour a tester has signed off as
   * wrong.
   *
   * The reason is unconfirmed_media_attachment rather than video_attachment
   * because handle-inbound probes the container bytes and x.test does not resolve.
   * A failed probe is a real production path and the honest verdict when it
   * happens; classification with a probe that succeeds is covered in
   * refine-media-type.spec.ts.
   */
  it('inbound with video attachment tells the owner without freezing the conversation', async () => {
    const fixture = JSON.parse(readFileSync(join(fixturesDir, 'salon-lumen.json'), 'utf8'));
    const salon = await salonsRepo.create(db, {
      displayName: fixture.display_name,
      ghlLocationId: fixture.ghl_location_id,
      ghlPit: fixture.ghl_pit,
      sourceOfTruth: fixture.source_of_truth,
      config: fixture.config,
    });

    testApp.ghl.stageMessage('msg-vid-1', '', [
      { url: 'https://x.test/v.mp4', type: 'video' },
    ]);

    // The bot cannot open the file, so it asks what the client is after. Staging a
    // reply at all is part of the point: the respond job must reach the worker.
    llm.stage({
      match: () => true,
      output: { text: 'tell me what you are hoping to achieve with your hair and we can get you sorted' },
    });

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

    // The client is answered.
    expect(llm.calls).toHaveLength(1);
    const log = await db.selectFrom('mock_outbound_log').selectAll().execute();
    expect(log).toHaveLength(1);

    // And the bot is NOT paused. A notify-only alert deliberately writes no
    // escalations row, because that table drives auto-resume by looking for rows
    // whose handoff has expired — with no handoff there is nothing to expire, so
    // the row would sit active forever and never release its tag.
    const escalations = await db.selectFrom('escalations').selectAll().execute();
    expect(escalations).toHaveLength(0);

    const conversations = await db.selectFrom('conversations').selectAll().execute();
    expect(conversations).toHaveLength(1);
    expect(conversations[0].handoff_until).toBeNull();

    // The event carries the record instead, and says it did not pause.
    const events = await db
      .selectFrom('conversation_events')
      .where('event_type', '=', 'escalated_to_owner')
      .selectAll()
      .execute();
    expect(events).toHaveLength(1);
    const payload =
      typeof events[0].payload === 'string' ? JSON.parse(events[0].payload) : events[0].payload;
    expect(payload).toMatchObject({ reason: 'unconfirmed_media_attachment', notifyOnly: true });

    // owner_fyi, never escalation_active: a tag that claims the bot is paused while
    // it keeps replying is what Round 3 called dishonest.
    const state = await db
      .selectFrom('mock_contact_state')
      .where('contact_id', '=', 'c_vid')
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(state.tags).toContain('owner_fyi');
    expect(state.tags).not.toContain('escalation_active');
  });
});
