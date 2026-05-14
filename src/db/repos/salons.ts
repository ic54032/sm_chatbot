import type { Db } from '../kysely.js';
import type { Salon } from '../../core/types.js';
import { SotSchema } from '../../core/sot-schema.js';
import { SalonConfigSchema } from '../../core/salon-config-schema.js';

export async function findByLocationId(db: Db, ghlLocationId: string): Promise<Salon | null> {
  const row = await db
    .selectFrom('salons')
    .where('ghl_location_id', '=', ghlLocationId)
    .where('is_active', '=', true)
    .selectAll()
    .executeTakeFirst();
  if (!row) return null;
  return rowToSalon(row);
}

export async function setActive(db: Db, id: string, active: boolean): Promise<void> {
  await db
    .updateTable('salons')
    .set({ is_active: active, updated_at: new Date() })
    .where('id', '=', id)
    .execute();
}

export async function findById(db: Db, id: string): Promise<Salon | null> {
  const row = await db
    .selectFrom('salons')
    .where('id', '=', id)
    .selectAll()
    .executeTakeFirst();
  if (!row) return null;
  return rowToSalon(row);
}

export async function create(db: Db, input: {
  displayName: string;
  ghlLocationId: string;
  ghlPit: string;
  sourceOfTruth: unknown;
  config: unknown;
}): Promise<Salon> {
  const sot = SotSchema.parse(input.sourceOfTruth);
  const cfg = SalonConfigSchema.parse(input.config);
  const row = await db
    .insertInto('salons')
    .values({
      display_name: input.displayName,
      ghl_location_id: input.ghlLocationId,
      ghl_pit: input.ghlPit,
      source_of_truth: JSON.stringify(sot),
      config: JSON.stringify(cfg),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return rowToSalon(row);
}

function rowToSalon(row: {
  id: string;
  display_name: string;
  ghl_location_id: string;
  ghl_pit: string;
  source_of_truth: unknown;
  config: unknown;
  is_active: boolean;
}): Salon {
  return {
    id: row.id,
    displayName: row.display_name,
    ghlLocationId: row.ghl_location_id,
    ghlPit: row.ghl_pit,
    sourceOfTruth: SotSchema.parse(row.source_of_truth),
    config: SalonConfigSchema.parse(row.config),
    isActive: row.is_active,
  };
}
