import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { Db } from '../db/kysely.js';
import { logger } from '../lib/logger.js';
import type { GhlClient } from './client.js';

export class MockGhlClient implements GhlClient {
  private getMessageStore = new Map<string, { text: string; attachments: Array<{ url: string; type: 'image' | 'audio' | 'video' }> }>();

  constructor(private db: Db) {}

  /** Test/dev helper: pre-stage a message so getMessage() can return it. */
  stageMessage(messageId: string, text: string, attachments: Array<{ url: string; type: 'image' | 'audio' | 'video' }> = []): void {
    this.getMessageStore.set(messageId, { text, attachments });
  }

  async sendMessage(input: { contactId: string; type: 'IG'; message: string }): Promise<{ ghlMessageId: string }> {
    const ghlMessageId = `mock_${randomUUID()}`;
    const salon = await this.db
      .selectFrom('salons')
      .innerJoin('conversations', 'conversations.salon_id', 'salons.id')
      .where('conversations.ghl_contact_id', '=', input.contactId)
      .select(['salons.id as salon_id'])
      .executeTakeFirst();

    await this.db
      .insertInto('mock_outbound_log')
      .values({
        salon_id: salon?.salon_id ?? '00000000-0000-0000-0000-000000000000',
        contact_id: input.contactId,
        type: input.type,
        message: input.message,
      })
      .execute();

    logger.info({ contactId: input.contactId, type: input.type, message: input.message }, '[mock-ghl] sendMessage');
    return { ghlMessageId };
  }

  async getMessage(messageId: string): Promise<{ text: string; attachments: Array<{ url: string; type: 'image' | 'audio' | 'video' }> }> {
    const staged = this.getMessageStore.get(messageId);
    if (staged) return staged;
    return { text: '', attachments: [] };
  }

  async addTag(contactId: string, tags: string[]): Promise<void> {
    await this.upsertContactState(contactId, (current) => ({
      ...current,
      tags: Array.from(new Set([...(current.tags ?? []), ...tags])),
    }));
    logger.info({ contactId, tags }, '[mock-ghl] addTag');
  }

  async removeTag(contactId: string, tags: string[]): Promise<void> {
    await this.upsertContactState(contactId, (current) => ({
      ...current,
      tags: (current.tags ?? []).filter((t: string) => !tags.includes(t)),
    }));
    logger.info({ contactId, tags }, '[mock-ghl] removeTag');
  }

  async updateCustomField(input: { contactId: string; fieldId: string; value: string | number | boolean }): Promise<void> {
    await this.upsertContactState(input.contactId, (current) => ({
      ...current,
      custom_fields: { ...(current.custom_fields ?? {}), [input.fieldId]: input.value },
    }));
    logger.info({ contactId: input.contactId, fieldId: input.fieldId, value: input.value }, '[mock-ghl] updateCustomField');
  }

  private async upsertContactState(
    contactId: string,
    mutator: (current: { tags?: string[]; custom_fields?: Record<string, unknown> }) => { tags?: string[]; custom_fields?: Record<string, unknown> },
  ): Promise<void> {
    const existing = await this.db
      .selectFrom('mock_contact_state')
      .where('contact_id', '=', contactId)
      .selectAll()
      .executeTakeFirst();

    const current = existing
      ? {
          tags: (existing.tags as string[]) ?? [],
          custom_fields: (existing.custom_fields as Record<string, unknown>) ?? {},
        }
      : { tags: [], custom_fields: {} };

    const next = mutator(current);

    await sql`
      INSERT INTO mock_contact_state (contact_id, tags, custom_fields, updated_at)
      VALUES (${contactId}, ${JSON.stringify(next.tags ?? [])}::jsonb, ${JSON.stringify(next.custom_fields ?? {})}::jsonb, now())
      ON CONFLICT (contact_id) DO UPDATE SET
        tags = EXCLUDED.tags,
        custom_fields = EXCLUDED.custom_fields,
        updated_at = now()
    `.execute(this.db);
  }
}
