import 'dotenv/config';
import { Kysely, Migrator, PostgresDialect, type Migration, type MigrationProvider } from 'kysely';
import pg from 'pg';
import { logger } from '../lib/logger.js';
import * as migration0001 from './migrations/0001_initial.js';

// Static migration provider — avoids kysely FileMigrationProvider's dynamic
// import() of .ts files, which Node ESM rejects in production (no TS loader).
// Same fix applied to tests/helpers/test-db.ts in commit 2aaad70.
const staticProvider: MigrationProvider = {
  async getMigrations(): Promise<Record<string, Migration>> {
    return {
      '0001_initial': migration0001 as Migration,
    };
  },
};

async function run() {
  const direction = (process.argv[2] ?? 'up') as 'up' | 'down';
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    logger.error('DATABASE_URL not set');
    process.exit(1);
  }

  const isLocal = databaseUrl.includes('localhost') || databaseUrl.includes('127.0.0.1');
  const db = new Kysely<unknown>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({
        connectionString: databaseUrl,
        ssl: isLocal ? false : { rejectUnauthorized: false },
      }),
    }),
  });

  const migrator = new Migrator({ db, provider: staticProvider });

  const { error, results } = direction === 'up'
    ? await migrator.migrateToLatest()
    : await migrator.migrateDown();

  results?.forEach((r) => {
    if (r.status === 'Success') logger.info({ migration: r.migrationName, direction: r.direction }, 'migration ok');
    else if (r.status === 'Error') logger.error({ migration: r.migrationName }, 'migration failed');
  });

  if (error) {
    logger.error({ err: error }, 'migration error');
    process.exit(1);
  }

  await db.destroy();
}

run();
