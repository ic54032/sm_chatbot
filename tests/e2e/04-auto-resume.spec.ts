import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDb, migrateTestDb, truncateAll } from '../helpers/test-db.js';
import { FakeLlmClient } from '../helpers/fake-llm-client.js';
import { buildTestApp } from '../helpers/test-app.js';
import * as salonsRepo from '../../src/db/repos/salons.js';
import * as escalationsRepo from '../../src/db/repos/escalations.js';
import * as conversationsRepo from '../../src/db/repos/conversations.js';
import * as eventsRepo from '../../src/db/repos/events.js';
import type { Kysely } from 'kysely';
import type { Database } from '../../src/db/schema.js';
import type { GhlClient } from '../../src/ghl/client.js';

const fixturesDir = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures');

async function runAutoResumeOnce(db: Kysely<Database>, ghl: GhlClient): Promise<void> {
  const items = await escalationsRepo.listActiveTimedOut(db, new Date());
  for (const item of items) {
    await escalationsRepo.markResumed(db, item.escalationId, 'auto_timeout');
    await conversationsRepo.setHandoffUntil(db, item.conversationId, null);
    await ghl.removeTag(item.contactId, ['escalation_active']);
    await eventsRepo.insert(db, item.conversationId, 'bot_resumed', { by: 'auto_timeout' });
  }
}

describe('e2e #4 — auto-resume after timeout', () => {
  const db = createTestDb();
  let testApp: Awaited<ReturnType<typeof buildTestApp>>;

  beforeAll(async () => {
    await migrateTestDb();
  });

  beforeEach(async () => {
    await truncateAll(db);
    testApp = await buildTestApp(db, new FakeLlmClient());
    await testApp.queue.obliterate({ force: true });
  });

  afterEach(async () => {
    await testApp.shutdown();
  });

  afterAll(async () => {
    await db.destroy();
  });

  it('clears handoff, removes tag, records event when handoff_until in past', async () => {
    const fixture = JSON.parse(readFileSync(join(fixturesDir, 'salon-bella.json'), 'utf8'));
    const salon = await salonsRepo.create(db, {
      displayName: fixture.display_name,
      ghlLocationId: fixture.ghl_location_id,
      ghlPit: fixture.ghl_pit,
      sourceOfTruth: fixture.source_of_truth,
      config: fixture.config,
    });

    const conv = await conversationsRepo.findOrCreate(db, salon.id, 'c_auto', null);
    const past = new Date(Date.now() - 60_000);
    await conversationsRepo.setHandoffUntil(db, conv.id, past);
    await escalationsRepo.upsertActive(db, conv.id, 'whatever', null);
    await testApp.ghl.addTag('c_auto', ['escalation_active']);

    await runAutoResumeOnce(db, testApp.ghl);

    const convAfter = await db
      .selectFrom('conversations')
      .where('id', '=', conv.id)
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(convAfter.handoff_until).toBeNull();

    const esc = await db
      .selectFrom('escalations')
      .where('conversation_id', '=', conv.id)
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(esc.resumed_at).not.toBeNull();
    expect(esc.resumed_by).toBe('auto_timeout');

    const state = await db
      .selectFrom('mock_contact_state')
      .where('contact_id', '=', 'c_auto')
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(state.tags).not.toContain('escalation_active');

    const events = await db
      .selectFrom('conversation_events')
      .where('event_type', '=', 'bot_resumed')
      .selectAll()
      .execute();
    expect(events).toHaveLength(1);
  });
});
