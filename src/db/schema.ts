import type { ColumnType, Generated } from 'kysely';

export interface Database {
  salons: SalonsTable;
  conversations: ConversationsTable;
  messages: MessagesTable;
  conversation_events: EventsTable;
  escalations: EscalationsTable;
  mock_outbound_log: MockOutboundLogTable;
  mock_contact_state: MockContactStateTable;
}

export interface SalonsTable {
  id: Generated<string>;
  display_name: string;
  ghl_location_id: string;
  ghl_pit: string;
  source_of_truth: ColumnType<unknown, string, string>;
  config: ColumnType<unknown, string, string>;
  is_active: ColumnType<boolean, boolean | undefined, boolean>;
  created_at: ColumnType<Date, never, never>;
  updated_at: ColumnType<Date, never, Date>;
}

export interface ConversationsTable {
  id: Generated<string>;
  salon_id: string;
  ghl_contact_id: string;
  ghl_conversation_id: string | null;
  client_handle: string | null;
  state: ColumnType<unknown, string, string>;
  handoff_until: ColumnType<Date | null, Date | null, Date | null>;
  last_message_at: ColumnType<Date | null, Date | null, Date | null>;
  created_at: ColumnType<Date, never, never>;
}

export interface MessagesTable {
  id: Generated<string>;
  conversation_id: string;
  direction: 'inbound' | 'outbound' | 'owner';
  channel_type: 'text' | 'image' | 'voice' | 'system';
  raw_content: ColumnType<unknown, string, string>;
  text_content: string | null;
  ai_raw_output: string | null;
  sanitize_mods: ColumnType<unknown, string | null, string | null>;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  cost_usd: string | null;
  ghl_message_id: string | null;
  created_at: ColumnType<Date, never, never>;
}

export interface EventsTable {
  id: Generated<string>;
  conversation_id: string;
  event_type: string;
  payload: ColumnType<unknown, string, string>;
  created_at: ColumnType<Date, never, never>;
}

export interface EscalationsTable {
  id: Generated<string>;
  conversation_id: string;
  reason: string;
  context_summary: string | null;
  ghl_tag_added_at: ColumnType<Date | null, Date | null, Date | null>;
  resumed_at: ColumnType<Date | null, Date | null, Date | null>;
  resumed_by: 'auto_timeout' | 'owner_manual' | null;
  created_at: ColumnType<Date, never, never>;
}

export interface MockOutboundLogTable {
  id: Generated<string>;
  salon_id: string;
  contact_id: string;
  type: string;
  message: string;
  sent_at: ColumnType<Date, never, never>;
}

export interface MockContactStateTable {
  contact_id: string;
  tags: ColumnType<unknown, string, string>;
  custom_fields: ColumnType<unknown, string, string>;
  updated_at: ColumnType<Date, never, Date>;
}
