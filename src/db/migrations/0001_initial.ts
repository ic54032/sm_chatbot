import type { Kysely } from 'kysely';
import { sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db);

  await sql`
    CREATE TABLE salons (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      display_name TEXT NOT NULL,
      ghl_location_id TEXT NOT NULL UNIQUE,
      ghl_pit TEXT NOT NULL,
      source_of_truth JSONB NOT NULL,
      config JSONB NOT NULL DEFAULT '{}',
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.execute(db);

  await sql`
    CREATE TABLE conversations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      salon_id UUID NOT NULL REFERENCES salons(id),
      ghl_contact_id TEXT NOT NULL,
      ghl_conversation_id TEXT,
      client_handle TEXT,
      state JSONB NOT NULL DEFAULT '{}',
      handoff_until TIMESTAMPTZ,
      last_message_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (salon_id, ghl_contact_id)
    )
  `.execute(db);

  await sql`CREATE INDEX idx_conv_salon_contact ON conversations(salon_id, ghl_contact_id)`.execute(db);

  await sql`
    CREATE TABLE messages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      conversation_id UUID NOT NULL REFERENCES conversations(id),
      direction TEXT NOT NULL CHECK (direction IN ('inbound','outbound','owner')),
      channel_type TEXT NOT NULL,
      raw_content JSONB NOT NULL,
      text_content TEXT,
      ai_raw_output TEXT,
      sanitize_mods JSONB,
      prompt_tokens INT,
      completion_tokens INT,
      cost_usd NUMERIC(10,6),
      ghl_message_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.execute(db);

  await sql`CREATE INDEX idx_msg_conv_time ON messages(conversation_id, created_at)`.execute(db);
  await sql`CREATE UNIQUE INDEX idx_msg_ghl_id ON messages(ghl_message_id) WHERE ghl_message_id IS NOT NULL`.execute(db);

  await sql`
    CREATE TABLE conversation_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      conversation_id UUID NOT NULL REFERENCES conversations(id),
      event_type TEXT NOT NULL,
      payload JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.execute(db);

  await sql`CREATE INDEX idx_event_conv_type_time ON conversation_events(conversation_id, event_type, created_at DESC)`.execute(db);

  await sql`
    CREATE TABLE escalations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      conversation_id UUID NOT NULL REFERENCES conversations(id),
      reason TEXT NOT NULL,
      context_summary TEXT,
      ghl_tag_added_at TIMESTAMPTZ,
      resumed_at TIMESTAMPTZ,
      resumed_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.execute(db);

  await sql`CREATE INDEX idx_esc_active ON escalations(conversation_id) WHERE resumed_at IS NULL`.execute(db);

  await sql`
    CREATE TABLE mock_outbound_log (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      salon_id UUID NOT NULL,
      contact_id TEXT NOT NULL,
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      sent_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.execute(db);

  await sql`
    CREATE TABLE mock_contact_state (
      contact_id TEXT PRIMARY KEY,
      tags JSONB NOT NULL DEFAULT '[]',
      custom_fields JSONB NOT NULL DEFAULT '{}',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS mock_contact_state CASCADE`.execute(db);
  await sql`DROP TABLE IF EXISTS mock_outbound_log CASCADE`.execute(db);
  await sql`DROP TABLE IF EXISTS escalations CASCADE`.execute(db);
  await sql`DROP TABLE IF EXISTS conversation_events CASCADE`.execute(db);
  await sql`DROP TABLE IF EXISTS messages CASCADE`.execute(db);
  await sql`DROP TABLE IF EXISTS conversations CASCADE`.execute(db);
  await sql`DROP TABLE IF EXISTS salons CASCADE`.execute(db);
}
