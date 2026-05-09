import type { Sot } from './sot-schema.js';
import type { SalonConfig } from './salon-config-schema.js';

export interface Salon {
  id: string;
  displayName: string;
  ghlLocationId: string;
  ghlPit: string;
  sourceOfTruth: Sot;
  config: SalonConfig;
  isActive: boolean;
}

export interface Conversation {
  id: string;
  salonId: string;
  ghlContactId: string;
  ghlConversationId: string | null;
  clientHandle: string | null;
  state: Record<string, unknown>;
  handoffUntil: Date | null;
  lastMessageAt: Date | null;
}

export interface Message {
  id: string;
  conversationId: string;
  direction: 'inbound' | 'outbound' | 'owner';
  channelType: 'text' | 'image' | 'voice' | 'system';
  textContent: string | null;
  aiRawOutput: string | null;
  sanitizeMods: string[] | null;
  ghlMessageId: string | null;
  createdAt: Date;
}

export interface ConversationEvent {
  id: string;
  conversationId: string;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: Date;
}

export interface ConversationContext {
  conversation: Conversation;
  recentMessages: Message[];
  recentEvents: ConversationEvent[];
}
