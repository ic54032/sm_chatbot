import type { ToolDefinition } from '../llm/client.js';

export const escalateToOwnerTool: ToolDefinition = {
  name: 'escalate_to_owner',
  description: 'Hand off the conversation to the salon owner. Use for complaints, refunds, VIP-named clients, or anything beyond bot scope.',
  input_schema: {
    type: 'object',
    properties: {
      reason: { type: 'string', description: 'Short reason e.g. "complaint", "refund_request", "vip_client".' },
      context_summary: { type: 'string', description: 'Optional one-sentence summary of what the client wants.' },
    },
    required: ['reason'],
  },
};

export const markLinkSentTool: ToolDefinition = {
  name: 'mark_link_sent',
  description: 'Call right before placing the booking link in the response. Records intent so the link is not repeated next turns.',
  input_schema: { type: 'object', properties: {} },
};

export const setStateFlagTool: ToolDefinition = {
  name: 'set_state_flag',
  description: 'Set a per-conversation state flag. Allowed keys: client_is_hesitant, last_quoted_service.',
  input_schema: {
    type: 'object',
    properties: {
      key: { type: 'string', enum: ['client_is_hesitant', 'last_quoted_service'] },
      value: {},
    },
    required: ['key', 'value'],
  },
};

export const allTools: ToolDefinition[] = [escalateToOwnerTool, markLinkSentTool, setStateFlagTool];
