import { describe, it, expect } from 'vitest';
import { heldEscalationCount } from '../../../src/db/repos/events.js';

/**
 * The query under the two-strike threshold.
 *
 * Every generate-response test mocks this function, so without this file the
 * query itself would ship untested: a wrong event_type or a missing conversation
 * filter would leave the whole suite green and break the threshold in production
 * — either holding a client's escalation forever or never holding it at all.
 *
 * The stub records what was asked of the query builder rather than running SQL,
 * which is enough to pin the three things that can silently go wrong: the table,
 * the filters, and how the reason is read out of the JSON payload.
 */
function fakeDb(rows: Array<{ payload: unknown }>) {
  const seen: { table?: string; where: Array<[string, string, unknown]> } = { where: [] };
  const builder = {
    where: (col: string, op: string, val: unknown) => {
      seen.where.push([col, op, val]);
      return builder;
    },
    select: () => builder,
    execute: async () => rows,
  };
  const db = { selectFrom: (table: string) => ((seen.table = table), builder) };
  return { db: db as never, seen };
}

const REASON = 'client_refused_consultation_path';

describe('heldEscalationCount', () => {
  it('reads conversation_events, filtered by conversation and by the held event type', async () => {
    const { db, seen } = fakeDb([]);
    await heldEscalationCount(db, 'conv-1', REASON);

    expect(seen.table).toBe('conversation_events');
    expect(seen.where).toEqual([
      ['conversation_id', '=', 'conv-1'],
      ['event_type', '=', 'escalation_held'],
    ]);
  });

  it('counts only the rows whose payload carries the reason asked for', async () => {
    const { db } = fakeDb([
      { payload: JSON.stringify({ reason: REASON }) },
      { payload: JSON.stringify({ reason: 'refund_request' }) },
      { payload: JSON.stringify({ reason: REASON }) },
    ]);
    expect(await heldEscalationCount(db, 'conv-1', REASON)).toBe(2);
  });

  it('returns 0 when the conversation has held nothing', async () => {
    const { db } = fakeDb([]);
    expect(await heldEscalationCount(db, 'conv-1', REASON)).toBe(0);
  });

  it('returns 0 when every held event was for a different reason', async () => {
    const { db } = fakeDb([{ payload: JSON.stringify({ reason: 'refund_request' }) }]);
    expect(await heldEscalationCount(db, 'conv-1', REASON)).toBe(0);
  });

  // Postgres hands jsonb back already parsed, sqlite hands back a string. Both
  // shapes reach this function depending on the driver.
  it('accepts a payload that arrives already parsed', async () => {
    const { db } = fakeDb([{ payload: { reason: REASON } }]);
    expect(await heldEscalationCount(db, 'conv-1', REASON)).toBe(1);
  });

  /**
   * A payload that will not parse must not throw. Throwing here would take down
   * the whole turn, so one corrupt row would stop the bot replying at all —
   * strictly worse than mis-counting.
   */
  it('ignores a payload that cannot be parsed instead of throwing', async () => {
    const { db } = fakeDb([
      { payload: '{not json' },
      { payload: null },
      { payload: JSON.stringify({ reason: REASON }) },
    ]);
    expect(await heldEscalationCount(db, 'conv-1', REASON)).toBe(1);
  });

  it('ignores a held event with no reason in its payload', async () => {
    const { db } = fakeDb([{ payload: JSON.stringify({}) }]);
    expect(await heldEscalationCount(db, 'conv-1', REASON)).toBe(0);
  });
});
