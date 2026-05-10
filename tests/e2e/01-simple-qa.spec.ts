import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDb, migrateTestDb, truncateAll } from '../helpers/test-db.js';
import { FakeLlmClient } from '../helpers/fake-llm-client.js';
import { buildTestApp } from '../helpers/test-app.js';
import * as salonsRepo from '../../src/db/repos/salons.js';

const fixturesDir = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures');

describe('e2e #1 — simple Q&A', () => {
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

  it('responds with sanitized text and persists outbound', async () => {
    const fixture = JSON.parse(readFileSync(join(fixturesDir, 'salon-bella.json'), 'utf8'));
    const salon = await salonsRepo.create(db, {
      displayName: fixture.display_name,
      ghlLocationId: fixture.ghl_location_id,
      ghlPit: fixture.ghl_pit,
      sourceOfTruth: fixture.source_of_truth,
      config: fixture.config,
    });

    llm.stage({
      match: () => true,
      output: { text: 'Hi! Yes we do balayage. Want to come in this week?' },
    });

    const res = await testApp.app.inject({
      method: 'POST',
      url: '/dev/simulate-inbound',
      payload: {
        location_id: salon.ghlLocationId,
        contact_id: 'c_qa',
        message_text: 'do you do balayage?',
      },
    });
    expect(res.statusCode).toBe(202);

    await new Promise((r) => setTimeout(r, 1500));

    const outbound = await db
      .selectFrom('messages')
      .where('direction', '=', 'outbound')
      .selectAll()
      .execute();
    expect(outbound).toHaveLength(1);
    expect(outbound[0].text_content).toContain('balayage');

    const log = await db.selectFrom('mock_outbound_log').selectAll().execute();
    expect(log).toHaveLength(1);
    expect(log[0].message).toContain('balayage');
  });
});
