import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDb, migrateTestDb, truncateAll } from '../helpers/test-db.js';
import { FakeLlmClient } from '../helpers/fake-llm-client.js';
import { buildTestApp } from '../helpers/test-app.js';
import * as salonsRepo from '../../src/db/repos/salons.js';

const fixturesDir = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures');

describe('e2e #3 — escalate_to_owner tool', () => {
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

  it('sets handoff, adds tag, updates field, and sends canned reassurance', async () => {
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
      output: {
        text: '',
        toolCalls: [{ id: 't1', name: 'escalate_to_owner', arguments: { reason: 'complaint' } }],
      },
    });

    await testApp.app.inject({
      method: 'POST',
      url: '/dev/simulate-inbound',
      payload: { location_id: salon.ghlLocationId, contact_id: 'c_esc', message_text: 'I want a refund' },
    });
    await new Promise((r) => setTimeout(r, 1500));

    // Phase C: when LLM emits only a tool call with empty text, backend sends a
    // canned reassurance line ("let me grab <owner> for you...") before escalating
    // so the client doesn't see silence. Prior behavior was zero outbound; that was
    // worse UX. Verify the fallback fired and contains the owner's first name.
    const outbound = await db.selectFrom('messages').where('direction', '=', 'outbound').selectAll().execute();
    expect(outbound).toHaveLength(1);
    expect(outbound[0].text_content).toContain(fixture.source_of_truth.salon.owner_first_name);

    const conv = await db
      .selectFrom('conversations')
      .where('ghl_contact_id', '=', 'c_esc')
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(conv.handoff_until).not.toBeNull();
    expect((conv.handoff_until as Date).getTime()).toBeGreaterThan(Date.now());

    const escalation = await db
      .selectFrom('escalations')
      .where('conversation_id', '=', conv.id)
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(escalation.reason).toBe('complaint');
    expect(escalation.resumed_at).toBeNull();

    const state = await db
      .selectFrom('mock_contact_state')
      .where('contact_id', '=', 'c_esc')
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(state.tags).toContain('escalation_active');
    expect((state.custom_fields as Record<string, unknown>)['field_reason']).toBe('complaint');
  });
});
