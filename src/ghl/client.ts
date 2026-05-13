export interface GhlClient {
  sendMessage(input: {
    contactId: string;
    type: 'IG';
    message: string;
  }): Promise<{ ghlMessageId: string }>;

  getMessage(messageId: string): Promise<{
    text: string;
    attachments: Array<{ url: string; type: 'image' | 'audio' | 'video' }>;
  }>;

  addTag(contactId: string, tags: string[]): Promise<void>;
  removeTag(contactId: string, tags: string[]): Promise<void>;

  updateCustomField(input: {
    contactId: string;
    fieldId: string;
    value: string | number | boolean;
  }): Promise<void>;
}

export type { GhlFactory } from './factory.js';
