import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { Database } from './schema.js';

export function createKyselyDb(databaseUrl: string): Kysely<Database> {
  const isLocal = databaseUrl.includes('localhost') || databaseUrl.includes('127.0.0.1');
  return new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({
        connectionString: databaseUrl,
        max: 10,
        ssl: isLocal ? false : { rejectUnauthorized: false },
      }),
    }),
  });
}

export type Db = Kysely<Database>;
