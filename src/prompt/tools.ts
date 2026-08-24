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

// mark_link_sent was removed on 2026-08-24. It was already redundant: the dedup
// event fires when the sent text contains the booking URL, so the tool only ever
// duplicated a fact the backend can read off its own outbound message. Keeping it
// cost a real reply — the model fired it with no text, which forces the corrective
// retry, and the retry cannot fit under the 30k TPM ceiling alongside the call that
// preceded it. On 2026-08-23 18:33 a client asked for the link, three 429s exhausted
// the retries, and the canned fallback went out without the URL in it.
export const allTools: ToolDefinition[] = [escalateToOwnerTool, setStateFlagTool];
