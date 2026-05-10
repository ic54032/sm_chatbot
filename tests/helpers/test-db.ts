import { Kysely, Migrator, PostgresDialect, sql, type Migration, type MigrationProvider } from 'kysely';
import pg from 'pg';
import type { Database } from '../../src/db/schema.js';
import * as migration0001 from '../../src/db/migrations/0001_initial.js';

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://salon:salon@localhost:55432/salon_test';

// Static migration provider — avoids kysely FileMigrationProvider's dynamic import()
// of .ts files at runtime, which Node ESM rejects in CI (no TS loader registered).
// Statically imported modules are transformed by vitest like any other source file.
const staticProvider: MigrationProvider = {
  async getMigrations(): Promise<Record<string, Migration>> {
    return {
      '0001_initial': migration0001 as Migration,
    };
  },
};

export function createTestDb(): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString: TEST_DB_URL }),
    }),
  });
}

export async function migrateTestDb(): Promise<void> {
  const db = createTestDb();
  const migrator = new Migrator({
    db: db as unknown as Kysely<unknown>,
    provider: staticProvider,
  });
  const { error, results } = await migrator.migrateToLatest();
  if (error) {
    await db.destroy();
    throw error;
  }
  results?.forEach((r) => {
    if (r.status === 'Error') {
      console.error('migration failed:', r.migrationName);
    } else {
      console.log('migration ok:', r.migrationName, r.direction);
    }
  });
  await db.destroy();
}

export async function truncateAll(db: Kysely<Database>): Promise<void> {
  await sql`
    TRUNCATE TABLE
      mock_contact_state,
      mock_outbound_log,
      escalations,
      conversation_events,
      messages,
      conversations,
      salons
    RESTART IDENTITY CASCADE
  `.execute(db);
}
