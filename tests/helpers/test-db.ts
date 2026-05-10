import { Kysely, Migrator, PostgresDialect, FileMigrationProvider, sql } from 'kysely';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';
import type { Database } from '../../src/db/schema.js';

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://salon:salon@localhost:55432/salon_test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Windows ESM workaround: same as src/db/migrate.ts. FileMigrationProvider passes
// joined Windows paths to import() which Node ESM rejects without file:// scheme.
const urlPath = {
  ...path,
  join: (...parts: string[]): string => {
    const joined = path.join(...parts);
    return pathToFileURL(joined).href;
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
    provider: new FileMigrationProvider({
      fs,
      path: urlPath,
      migrationFolder: path.resolve(__dirname, '../../src/db/migrations'),
    }),
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
