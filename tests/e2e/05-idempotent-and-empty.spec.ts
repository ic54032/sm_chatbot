import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDb, migrateTestDb, truncateAll } from '../helpers/test-db.js';
import { FakeLlmClient } from '../helpers/fake-llm-client.js';
import { buildTestApp } from '../helpers/test-app.js';
import * as salonsRepo from '../../src/db/repos/salons.js';

const fixturesDir = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures');

describe('e2e #5 — idempotent inbound and sanitizer empty escalates', () => {
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

  it('duplicate ghl_message_id ingested only once', async () => {
    const fixture = JSON.parse(readFileSync(join(fixturesDir, 'salon-lumen.json'), 'utf8'));
    const salon = await salonsRepo.create(db, {
      displayName: fixture.display_name,
      ghlLocationId: fixture.ghl_location_id,
      ghlPit: fixture.ghl_pit,
      sourceOfTruth: fixture.source_of_truth,
      config: fixture.config,
    });

    llm.stage({ match: () => true, output: { text: 'Hi!' } });

    const payload = {
      location_id: salon.ghlLocationId,
      contact_id: 'c_idem',
      message_text: 'hi',
      message_id: 'msg_dup_1',
    };
    await testApp.app.inject({ method: 'POST', url: '/dev/simulate-inbound', payload });
    await new Promise((r) => setTimeout(r, 200));
    await testApp.app.inject({ method: 'POST', url: '/dev/simulate-inbound', payload });
    await new Promise((r) => setTimeout(r, 1500));

    const inbounds = await db
      .selectFrom('messages')
      .where('direction', '=', 'inbound')
      .selectAll()
      .execute();
    expect(inbounds).toHaveLength(1);
  });

  it('LLM output that sanitizes to empty triggers escalation', async () => {
    const fixture = JSON.parse(readFileSync(join(fixturesDir, 'salon-lumen.json'), 'utf8'));
    const salon = await salonsRepo.create(db, {
      displayName: fixture.display_name,
      ghlLocationId: fixture.ghl_location_id,
      ghlPit: fixture.ghl_pit,
      sourceOfTruth: fixture.source_of_truth,
      config: fixture.config,
    });

    // LLM returns only ellipses, which sanitizer strips → empty → escalate
    llm.stage({ match: () => true, output: { text: '………' } });

    await testApp.app.inject({
      method: 'POST',
      url: '/dev/simulate-inbound',
      payload: { location_id: salon.ghlLocationId, contact_id: 'c_empty', message_text: 'hello' },
    });
    await new Promise((r) => setTimeout(r, 1500));

    const outbound = await db.selectFrom('messages').where('direction', '=', 'outbound').selectAll().execute();
    expect(outbound).toHaveLength(0);

    const conv = await db
      .selectFrom('conversations')
      .where('ghl_contact_id', '=', 'c_empty')
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(conv.handoff_until).not.toBeNull();

    const esc = await db
      .selectFrom('escalations')
      .where('conversation_id', '=', conv.id)
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(esc.reason).toBe('sanitizer_empty_output');
  });
});
