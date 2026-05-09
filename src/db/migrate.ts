import 'dotenv/config';
import { Kysely, Migrator, PostgresDialect, FileMigrationProvider } from 'kysely';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';
import { logger } from '../lib/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Windows ESM workaround: FileMigrationProvider passes the joined path to
// dynamic import(), which on Windows requires a file:// URL. Wrap path so that
// join() produces a file:// URL string the ESM loader accepts.
const urlPath = {
  ...path,
  join: (...parts: string[]) => pathToFileURL(path.join(...parts)).href,
};

async function run() {
  const direction = (process.argv[2] ?? 'up') as 'up' | 'down';
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    logger.error('DATABASE_URL not set');
    process.exit(1);
  }

  const db = new Kysely<unknown>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: databaseUrl }) }),
  });

  const migrator = new Migrator({
    db,
    provider: new FileMigrationProvider({
      fs,
      path: urlPath,
      migrationFolder: path.resolve(__dirname, 'migrations'),
    }),
  });

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
