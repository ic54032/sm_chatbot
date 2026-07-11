import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDb, migrateTestDb, truncateAll } from '../helpers/test-db.js';
import { FakeLlmClient } from '../helpers/fake-llm-client.js';
import { buildTestApp } from '../helpers/test-app.js';
import * as salonsRepo from '../../src/db/repos/salons.js';

const fixturesDir = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures');

describe('e2e #2 — booking link is not stripped across turns', () => {
  const db = createTestDb();
  let testApp: Awaited<ReturnType<typeof buildTestApp>>;
  let llm: FakeLlmClient;

  beforeAll(async () => {
    await migrateTestDb();
  });

  beforeEach(async () => {
    await truncateAll(db);
    llm = new FakeLlmClient();
    testApp = await buildTestApp(db, llm);
    await testApp.queue.obliterate({ force: true });
  });

  afterEach(async () => {
    await testApp.shutdown();
  });

  afterAll(async () => {
    await db.destroy();
  });

  it('keeps the link on both turns — no across-turn dedup (client may re-request it)', async () => {
    const fixture = JSON.parse(readFileSync(join(fixturesDir, 'salon-lumen.json'), 'utf8'));
    const salon = await salonsRepo.create(db, {
      displayName: fixture.display_name,
      ghlLocationId: fixture.ghl_location_id,
      ghlPit: fixture.ghl_pit,
      sourceOfTruth: fixture.source_of_truth,
      config: fixture.config,
    });

    const bookingUrl = fixture.source_of_truth.booking.url;
    const linkResponse = `Sure! Book here ${bookingUrl}`;
    llm.stage({ match: () => true, output: { text: linkResponse } });

    await testApp.app.inject({
      method: 'POST',
      url: '/dev/simulate-inbound',
      payload: { location_id: salon.ghlLocationId, contact_id: 'c_dedup', message_text: 'send me the link' },
    });
    await new Promise((r) => setTimeout(r, 1500));

    const outboundsTurn1 = await db
      .selectFrom('messages')
      .where('direction', '=', 'outbound')
      .selectAll()
      .execute();
    expect(outboundsTurn1).toHaveLength(1);
    expect(outboundsTurn1[0].text_content).toContain(bookingUrl);

    // Same response staged for turn 2. The client is effectively re-requesting
    // the link, so it must survive — the sanitizer no longer strips it.
    await testApp.app.inject({
      method: 'POST',
      url: '/dev/simulate-inbound',
      payload: { location_id: salon.ghlLocationId, contact_id: 'c_dedup', message_text: 'one more time?' },
    });
    await new Promise((r) => setTimeout(r, 1500));

    const outboundsAll = await db
      .selectFrom('messages')
      .where('direction', '=', 'outbound')
      .orderBy('created_at', 'asc')
      .selectAll()
      .execute();
    expect(outboundsAll).toHaveLength(2);
    expect(outboundsAll[1].text_content).toContain(bookingUrl);
    const sanitizeMods = outboundsAll[1].sanitize_mods as string[];
    expect(sanitizeMods).not.toContain('booking_link_deduplicated');
  });
});
