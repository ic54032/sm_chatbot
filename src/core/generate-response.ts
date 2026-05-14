import type { Db } from '../db/kysely.js';
import type { GhlClient } from '../ghl/client.js';
import type { LlmClient } from '../llm/client.js';
import type { Salon } from './types.js';
import * as conversationsRepo from '../db/repos/conversations.js';
import * as messagesRepo from '../db/repos/messages.js';
import * as eventsRepo from '../db/repos/events.js';
import { sanitize } from '../sanitizer/index.js';
import { buildPrompt } from '../prompt/build.js';
import { allTools } from '../prompt/tools.js';
import { escalateToOwner } from './escalate.js';
import { SanitizerEmptyOutputError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

const ALLOWED_STATE_KEYS = ['client_is_hesitant', 'last_quoted_service'] as const;

export interface GenerateResponseDeps {
  db: Db;
  ghl: GhlClient;
  llm: LlmClient;
  defaultLlmModel: string;
}

export async function generateResponse(deps: GenerateResponseDeps, salon: Salon, conversationId: string): Promise<void> {
  const ctx = await conversationsRepo.loadContext(deps.db, conversationId, 15);

  if (ctx.conversation.handoffUntil && ctx.conversation.handoffUntil > new Date()) {
    logger.info({ conversationId }, 'handoff active at worker; skipping');
    return;
  }

  const bookingLinkRecentlySent = await eventsRepo.recentBookingLinkSent(
    deps.db,
    conversationId,
    salon.config.booking_link_dedup_window,
  );
  const prompt = buildPrompt(salon, ctx, bookingLinkRecentlySent);

  let llmResult: Awaited<ReturnType<typeof deps.llm.complete>>;
  let attempts = 0;
  while (true) {
    try {
      llmResult = await deps.llm.complete({
        systemPrompt: prompt.systemPrompt,
        messages: prompt.messages,
        tools: allTools,
        model: salon.config.llm_model ?? deps.defaultLlmModel,
        maxTokens: 512,
      });
      break;
    } catch (err) {
      attempts++;
      logger.warn({ err, attempts, conversationId }, 'llm.complete failed; retrying');
      if (attempts >= 3) {
        await escalateToOwner({
          db: deps.db,
          ghl: deps.ghl,
          salon,
          conversation: ctx.conversation,
          reason: 'llm_failed',
        });
        return;
      }
      const backoff = 500 * 2 ** attempts;
      await new Promise((r) => setTimeout(r, backoff));
    }
  }

  // Collect tool intentions. Defer escalate_to_owner execution until AFTER send
  // so the LLM-generated reassurance text (e.g. "let me grab Sarah for you")
  // reaches the client before the tag flips and the bot goes silent.
  let escalationArgs: { reason: string; contextSummary?: string } | undefined;
  let linkSentToolCalled = false;
  for (const call of llmResult.toolCalls) {
    if (call.name === 'escalate_to_owner') {
      const reason = (call.arguments.reason as string | undefined) ?? 'unspecified';
      const summary = call.arguments.context_summary as string | undefined;
      escalationArgs = { reason, contextSummary: summary };
    } else if (call.name === 'mark_link_sent') {
      linkSentToolCalled = true;
    } else if (call.name === 'set_state_flag') {
      const key = call.arguments.key as string | undefined;
      const value = call.arguments.value;
      if (key && (ALLOWED_STATE_KEYS as readonly string[]).includes(key)) {
        await conversationsRepo.mergeState(deps.db, conversationId, { [key]: value });
      } else {
        logger.warn({ conversationId, key }, 'rejected unknown state flag');
      }
    }
  }

  let sanitized: Awaited<ReturnType<typeof sanitize>>;
  try {
    sanitized = await sanitize(llmResult.text, {
      bookingLink: salon.sourceOfTruth.salon.booking_link,
      bookingLinkSentInLastN: (n) => eventsRepo.recentBookingLinkSent(deps.db, conversationId, n),
      policy: {
        maxWordsPerMessage: salon.config.max_words_per_message,
        maxEmojis: salon.config.max_emojis,
        bookingLinkDedupWindow: salon.config.booking_link_dedup_window,
      },
    });
  } catch (err) {
    if (err instanceof SanitizerEmptyOutputError) {
      // Empty output is only an unexpected failure when LLM had no escalation intent.
      // If LLM already flagged escalate, substitute a canned reassurance line so the
      // client doesn't see silence. Gemini (and other tool-tuned models) often emit
      // only the tool call without accompanying text, so we can't rely on the prompt
      // alone to produce the handoff message.
      if (escalationArgs) {
        const owner = salon.sourceOfTruth.salon.owner_first_name;
        const fallback = `let me grab ${owner} for you, she'll jump in as soon as she's between clients 🤍`;
        sanitized = { messages: [fallback], modifications: ['escalation_fallback_text'] };
      } else {
        await escalateToOwner({
          db: deps.db,
          ghl: deps.ghl,
          salon,
          conversation: ctx.conversation,
          reason: 'sanitizer_empty_output',
        });
        return;
      }
    } else {
      throw err;
    }
  }

  for (const message of sanitized.messages) {
    logger.info({ conversationId, message }, 'sending message to ghl');
    try {
      const sent = await deps.ghl.sendMessage({
        contactId: ctx.conversation.ghlContactId,
        type: 'IG',
        message,
      });
      await messagesRepo.insertOutbound(deps.db, {
        conversationId,
        textContent: message,
        aiRawOutput: llmResult.text,
        sanitizeMods: sanitized.modifications,
        promptTokens: llmResult.usage.inputTokens,
        completionTokens: llmResult.usage.outputTokens,
        costUsd: null,
        ghlMessageId: sent.ghlMessageId,
      });
    } catch (err) {
      logger.error({ err, conversationId }, 'ghl sendMessage failed');
      // Send fail takes precedence over LLM-requested escalation reason — operator
      // needs to know send is broken, not whatever the conversation context was.
      await escalateToOwner({
        db: deps.db,
        ghl: deps.ghl,
        salon,
        conversation: ctx.conversation,
        reason: 'cannot_reply_outside_window',
      });
      return;
    }
  }

  // After successful send, do the LLM-requested escalation. Owner gets push,
  // opens conversation, sees customer's message + bot's reassurance, takes over.
  if (escalationArgs) {
    await escalateToOwner({
      db: deps.db,
      ghl: deps.ghl,
      salon,
      conversation: ctx.conversation,
      reason: escalationArgs.reason,
      contextSummary: escalationArgs.contextSummary,
    });
    return;
  }

  // Record booking_link_sent event AFTER successful send so the dedup window starts
  // from the next turn, not the current one. Either the LLM declared intent via
  // mark_link_sent or post-sanitize scan found the link in final output.
  const containsLink = sanitized.messages.some((m) => m.includes(salon.sourceOfTruth.salon.booking_link));
  if (linkSentToolCalled || containsLink) {
    await eventsRepo.insert(deps.db, conversationId, 'booking_link_sent', {});
  }
}
