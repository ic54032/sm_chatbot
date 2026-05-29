import type { Db } from '../db/kysely.js';
import type { GhlClient } from '../ghl/client.js';
import type { LlmClient } from '../llm/client.js';
import type { Salon } from './types.js';
import * as conversationsRepo from '../db/repos/conversations.js';
import * as messagesRepo from '../db/repos/messages.js';
import * as eventsRepo from '../db/repos/events.js';
import * as salonsRepo from '../db/repos/salons.js';
import { sanitize } from '../sanitizer/index.js';
import { buildPrompt } from '../prompt/build.js';
import { allTools } from '../prompt/tools.js';
import { escalateToOwner } from './escalate.js';
import { GhlApiError } from '../ghl/errors.js';
import { SanitizerEmptyOutputError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { extractImageAttachments } from '../images/extract-attachments.js';
import { fetchAttachment as defaultFetchAttachment } from '../images/fetch.js';
import { processImageForVision, type ProcessedImage } from '../images/process.js';

const ALLOWED_STATE_KEYS = ['client_is_hesitant', 'last_quoted_service'] as const;

export interface GenerateResponseDeps {
  db: Db;
  ghl: GhlClient;
  llm: LlmClient;
  defaultLlmModel: string;
  /**
   * Testability hook for image attachment HTTP fetches. Defaults to the real
   * implementation in src/images/fetch.ts. Unit tests inject a stub so they
   * don't make actual network calls.
   */
  fetchAttachment?: typeof defaultFetchAttachment;
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

  // ── Image orchestration ─────────────────────────────────────────────────────
  // Fetch + process images for every inbound message in the recent window so the
  // LLM can see the actual pixels. OpenAI vision cache absorbs the cost of
  // refetching historical images turn after turn. We distinguish current-turn
  // failures (escalate, bot can't reply meaningfully) from historical failures
  // (log+skip, the current message is still actionable).
  const imagesByMessageId = new Map<string, ProcessedImage[]>();
  const lastInbound = [...ctx.recentMessages].reverse().find((m) => m.direction === 'inbound');
  const lastInboundAttachments = lastInbound ? extractImageAttachments(lastInbound.rawContent) : [];

  if (!salon.config.image_processing.enabled && lastInboundAttachments.length > 0) {
    logger.info({ conversationId, salonId: salon.id }, 'image_processing disabled; escalating');
    await escalateToOwner({
      db: deps.db,
      ghl: deps.ghl,
      salon,
      conversation: ctx.conversation,
      reason: 'image_processing_disabled',
    });
    return;
  }

  if (salon.config.image_processing.enabled) {
    const fetchFn = deps.fetchAttachment ?? defaultFetchAttachment;

    // Paralelni fetch unutar iste poruke, serijski među porukama (rate-limit safe).
    for (const msg of ctx.recentMessages) {
      if (msg.direction !== 'inbound') continue;
      const rawAttachments = extractImageAttachments(msg.rawContent);
      if (rawAttachments.length === 0) continue;

      const settled = await Promise.allSettled(
        rawAttachments.map(async (att) => {
          const buf = await fetchFn(att.url, salon.ghlPit);
          const processed = await processImageForVision(buf, {
            maxDimension: salon.config.image_processing.max_dimension,
            jpegQuality: salon.config.image_processing.jpeg_quality,
          });
          // DIAGNOSTIC: dimensions + byte ratios. Bot saying "I can't see the
          // photo details" while imageCount=1 was reaching the LLM call —
          // likely either GHL CDN serves a thumbnail (low-res input) or our
          // sharp pipeline is over-compressing. This log decides.
          logger.info(
            {
              messageId: msg.id,
              url: att.url,
              bytesIn: processed.bytesIn,
              bytesOut: processed.bytesOut,
              width: processed.width,
              height: processed.height,
              compressionRatio: (processed.bytesOut / Math.max(processed.bytesIn, 1)).toFixed(2),
            },
            'image fetch+process result',
          );
          return processed;
        }),
      );

      const succeeded: ProcessedImage[] = [];
      for (const r of settled) {
        if (r.status === 'fulfilled') {
          succeeded.push(r.value);
        } else {
          logger.warn({ err: r.reason, messageId: msg.id }, 'image fetch/process failed; skipping');
        }
      }
      if (succeeded.length > 0) imagesByMessageId.set(msg.id, succeeded);
    }

    // Current-turn failure check: if the LAST inbound had image attachments but
    // none survived fetch+process, escalate. The signal is too important to lose
    // silently — owner needs to intervene.
    if (lastInbound && lastInboundAttachments.length > 0) {
      const processedForLast = imagesByMessageId.get(lastInbound.id);
      if (!processedForLast || processedForLast.length === 0) {
        logger.warn({ conversationId, messageId: lastInbound.id }, 'current-turn image fetch failed; escalating');
        await escalateToOwner({
          db: deps.db,
          ghl: deps.ghl,
          salon,
          conversation: ctx.conversation,
          reason: 'attachment_fetch_failed',
        });
        return;
      }
    }
  }

  const prompt = buildPrompt({ salon, ctx, bookingLinkRecentlySent, imagesByMessageId });

  // DIAGNOSTIC: confirm whether image content blocks actually reach the LLM call.
  // Empirical question: bot's response sounded image-aware on first turn but
  // refused to describe colors on follow-up — could be hallucination from prompt
  // alone or genuine model behavior. This log tells us definitively.
  const messageShapes = prompt.messages.map((m, i) => {
    if (typeof m.content === 'string') {
      return { idx: i, role: m.role, kind: 'text', textLen: m.content.length, imageCount: 0 };
    }
    const blocks = m.content;
    const imageBlocks = blocks.filter((b) => b.type === 'image');
    const textBlocks = blocks.filter((b) => b.type === 'text');
    return {
      idx: i,
      role: m.role,
      kind: 'multimodal',
      textLen: textBlocks.reduce((s, b) => s + (b.type === 'text' ? b.text.length : 0), 0),
      imageCount: imageBlocks.length,
      imageMediaTypes: imageBlocks.map((b) => (b.type === 'image' ? b.mediaType : 'n/a')),
      imageBase64Lens: imageBlocks.map((b) => (b.type === 'image' ? b.base64.length : 0)),
    };
  });
  logger.info(
    { conversationId, llmModel: salon.config.llm_model ?? deps.defaultLlmModel, messageShapes },
    'llm call composition debug',
  );

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
      logger.info({
        conversationId,
        textLen: llmResult.text.length,
        textPreview: llmResult.text.slice(0, 200),
        toolCalls: llmResult.toolCalls.map((c) => c.name),
        inputTokens: llmResult.usage.inputTokens,
        outputTokens: llmResult.usage.outputTokens,
      }, 'llm response received');
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
      bookingLink: salon.sourceOfTruth.booking.url,
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
        const owner = salon.sourceOfTruth.salon_basics.owner_first_name;
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
      if (err instanceof GhlApiError && (err.status === 401 || err.status === 403)) {
        logger.error({ err, salonId: salon.id }, 'GHL auth failed during sendMessage; disabling salon');
        await salonsRepo.setActive(deps.db, salon.id, false);
        await escalateToOwner({
          db: deps.db,
          ghl: deps.ghl,
          salon,
          conversation: ctx.conversation,
          reason: 'ghl_auth_failed',
        });
      } else {
        await escalateToOwner({
          db: deps.db,
          ghl: deps.ghl,
          salon,
          conversation: ctx.conversation,
          reason: 'cannot_reply_outside_window',
        });
      }
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
  const containsLink = sanitized.messages.some((m) => m.includes(salon.sourceOfTruth.booking.url));
  if (linkSentToolCalled || containsLink) {
    await eventsRepo.insert(deps.db, conversationId, 'booking_link_sent', {});
  }
}
