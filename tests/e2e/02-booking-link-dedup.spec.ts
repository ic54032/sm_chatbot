import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDb, migrateTestDb, truncateAll } from '../helpers/test-db.js';
import { FakeLlmClient } from '../helpers/fake-llm-client.js';
import { buildTestApp } from '../helpers/test-app.js';
import * as salonsRepo from '../../src/db/repos/salons.js';

const fixturesDir = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures');

describe('e2e #2 — booking link dedup across turns', () => {
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

  it('first turn keeps link, second turn strips it', async () => {
    const fixture = JSON.parse(readFileSync(join(fixturesDir, 'salon-lumen.json'), 'utf8'));
    const salon = await salonsRepo.create(db, {
      displayName: fixture.display_name,
      ghlLocationId: fixture.ghl_location_id,
      ghlPit: fixture.ghl_pit,
      sourceOfTruth: fixture.source_of_truth,
      config: fixture.config,
    });

    const linkResponse = 'Sure! Book here https://bellahair.example.com/book';
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
    expect(outboundsTurn1[0].text_content).toContain('https://bellahair.example.com/book');

    // Same response staged for turn 2; sanitizer should strip the link.
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
    expect(outboundsAll[1].text_content).not.toContain('https://bellahair.example.com/book');
    const sanitizeMods = outboundsAll[1].sanitize_mods as string[];
    expect(sanitizeMods).toContain('booking_link_deduplicated');
  });
});
