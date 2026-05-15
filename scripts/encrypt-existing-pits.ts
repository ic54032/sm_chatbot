import 'dotenv/config';
import { loadConfig } from '../src/config.js';
import { createKyselyDb } from '../src/db/kysely.js';
import { encryptPit, isEncrypted } from '../src/lib/crypto.js';

async function main() {
  const cfg = loadConfig();
  if (!cfg.pitEncryptionKey) {
    console.error('PIT_ENCRYPTION_KEY not set; nothing to do.');
    process.exit(1);
  }
  const db = createKyselyDb(cfg.databaseUrl);
  const rows = await db.selectFrom('salons').select(['id', 'ghl_pit']).execute();
  let migrated = 0;
  let skipped = 0;
  for (const row of rows) {
    if (isEncrypted(row.ghl_pit)) {
      skipped++;
      continue;
    }
    const encrypted = encryptPit(row.ghl_pit, cfg.pitEncryptionKey);
    await db.updateTable('salons').set({ ghl_pit: encrypted }).where('id', '=', row.id).execute();
    migrated++;
  }
  console.log(`Migrated ${migrated} plaintext PITs; ${skipped} already encrypted.`);
  await db.destroy();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
