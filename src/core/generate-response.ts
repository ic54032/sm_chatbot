import type { Db } from '../db/kysely.js';
import type { GhlClient } from '../ghl/client.js';
import type { LlmClient } from '../llm/client.js';
import type { Salon } from './types.js';
import * as conversationsRepo from '../db/repos/conversations.js';
import * as messagesRepo from '../db/repos/messages.js';
import * as eventsRepo from '../db/repos/events.js';
import * as salonsRepo from '../db/repos/salons.js';
import { sanitize } from '../sanitizer/index.js';
import { matchInternalVocab } from '../sanitizer/internal-vocab.js';
import { containsBookingIntent } from './detect-booking-intent.js';
import { isRetryableLlmError, retryDelayMs } from '../llm/is-retryable.js';
import { buildPrompt } from '../prompt/build.js';
import { withoutImageBlocks } from '../prompt/strip-images.js';
import { allTools } from '../prompt/tools.js';
import { escalateToOwner } from './escalate.js';
import { containsHandoffPromise } from './detect-handoff-promise.js';
import { extractLeakedToolCalls } from './extract-leaked-tool-calls.js';
import { GhlApiError } from '../ghl/errors.js';
import { SanitizerEmptyOutputError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { extractImageAttachments } from '../images/extract-attachments.js';
import { fetchAttachment as defaultFetchAttachment } from '../images/fetch.js';
import { processImageForVision, type ProcessedImage } from '../images/process.js';

const ALLOWED_STATE_KEYS = ['client_is_hesitant', 'last_quoted_service'] as const;

// The eight escalation reasons the master prompt defines. Reasons recovered
// from LEAKED text-form tool calls are validated against this set (native
// tool-call args stay free-form) so model-mangled or client-quoted text can't
// end up in the owner's GHL last_escalation_reason field.
const LEAKED_ESCALATION_REASONS = new Set([
  'refund_request',
  'vip_client',
  'medical_question',
  'explicit_request_for_owner',
  'this_salon_complaint',
  'unanswered_question',
  'client_refused_consultation_path',
  'hostile_language',
]);

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

export interface GenerateResponseResult {
  /** The newest inbound message this run actually loaded into context. The
   * worker compares it against the live latest inbound afterward: if a newer
   * message arrived DURING processing (the text+photo coalescing race, B6), it
   * re-enqueues so that message is not stranded unanswered. null means "do not
   * re-drive" (skipped/escalated paths). */
  latestInboundAt: Date | null;
}

/**
 * Names from the salon's own knowledge base that must keep their capital when
 * the lowercase style pass runs: the salon, the owner, every stylist. Read
 * defensively — the SOT is per-salon JSON and a field may simply be absent.
 */
function salonProperNouns(salon: Salon): string[] {
  const sot = salon.sourceOfTruth as {
    salon_basics?: { salon_name?: unknown; owner_first_name?: unknown };
    stylist_directory?: { stylists?: Array<{ preferred_name?: unknown; full_name?: unknown }> };
  };
  const names: unknown[] = [sot.salon_basics?.salon_name, sot.salon_basics?.owner_first_name];
  for (const stylist of sot.stylist_directory?.stylists ?? []) {
    names.push(stylist?.preferred_name, stylist?.full_name);
  }

  // Everything else the salon capitalises MID-SENTENCE in its own knowledge base
  // is a proper noun too — product and brand names like Olaplex, a street name,
  // a neighbouring business. Mid-sentence is the discriminator: a capital at the
  // start of a policy sentence ("Cancellations under 24 hours...") is grammar,
  // not a name, and protecting it would blunt the whole pass.
  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      for (const [, word] of node.matchAll(/[^.!?]\s+(\p{Lu}[\p{Ll}]{2,})/gu)) names.push(word);
      return;
    }
    if (Array.isArray(node)) return node.forEach(walk);
    if (node && typeof node === 'object') return Object.values(node).forEach(walk);
  };
  walk(salon.sourceOfTruth);

  return [...new Set(names.filter((n): n is string => typeof n === 'string' && n.trim().length > 0))];
}

export async function generateResponse(
  deps: GenerateResponseDeps,
  salon: Salon,
  conversationId: string,
): Promise<GenerateResponseResult> {
  const ctx = await conversationsRepo.loadContext(deps.db, conversationId, 15);
  const latestInboundAt = ctx.recentMessages.reduce<Date | null>(
    (max, m) => (m.direction === 'inbound' && (!max || m.createdAt > max) ? m.createdAt : max),
    null,
  );

  if (ctx.conversation.handoffUntil && ctx.conversation.handoffUntil > new Date()) {
    logger.info({ conversationId }, 'handoff active at worker; skipping');
    return { latestInboundAt: null };
  }

  // Answered-guard: skip if every inbound we loaded has already been answered by
  // an earlier reply. Compare the newest loaded inbound against the newest
  // inbound a prior reply actually addressed (recorded as a 'replied' event,
  // written after every successful send). This is the CORRECT predicate: the
  // "last message" alone is unreliable, because a reply is always timestamped
  // AFTER a message it did not answer, so a mid-processing inbound (the B6
  // coalescing-race message) sits sandwiched just before an outbound. Comparing
  // against what was actually answered lets a redundant run (a drain racing a
  // normal job) no-op WITHOUT wrongly skipping the stranded message the drain
  // exists to deliver.
  if (!latestInboundAt) {
    return { latestInboundAt: null }; // no inbound in the window, nothing to answer
  }
  const lastAnsweredInboundAt = await eventsRepo.latestRepliedInboundAt(deps.db, conversationId);
  if (lastAnsweredInboundAt && latestInboundAt.getTime() <= lastAnsweredInboundAt.getTime()) {
    logger.info({ conversationId }, 'newest inbound already answered by a prior reply; skipping');
    return { latestInboundAt: null };
  }

  const bookingLinkRecentlySent = await eventsRepo.recentBookingLinkSent(
    deps.db,
    conversationId,
    salon.config.booking_link_dedup_window_hours,
  );

  // ── Image orchestration ─────────────────────────────────────────────────────
  // Fetch + process images for every inbound message in the recent window so the
  // LLM can see the actual pixels. OpenAI vision cache absorbs the cost of
  // refetching historical images turn after turn. We distinguish current-turn
  // failures (escalate, bot can't reply meaningfully) from historical failures
  // (log+skip, the current message is still actionable).
  const imagesByMessageId = new Map<string, ProcessedImage[]>();
  // Inbound messages whose image(s) were attached but could not be fetched or
  // processed (oversize GIF, expired CDN URL, decode error). The model gets a
  // marker for these so it asks for a resend instead of us silently escalating.
  const unviewableImageMessageIds = new Set<string>();
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
    return { latestInboundAt: null };
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

    // Current-turn failure: mark every message in the trailing inbound burst
    // (the current turn, which a coalesced "photo then text" burst can split
    // across messages) whose image(s) all failed to fetch/process. DO NOT
    // silently escalate and pause the bot for the whole handoff window
    // (production 2026: an oversize reaction GIF paged the owner and left the
    // client in silence for hours, so they disengaged). Instead degrade to a
    // live text reply — the [photo not received] marker makes the model warmly
    // ask for a resend — and keep the conversation alive. Historical failures
    // (before the last outbound) stay skipped, not marked.
    for (let i = ctx.recentMessages.length - 1; i >= 0; i--) {
      const m = ctx.recentMessages[i];
      if (m.direction !== 'inbound') break; // reached the start of the trailing burst
      const atts = extractImageAttachments(m.rawContent);
      if (atts.length > 0 && !imagesByMessageId.get(m.id)?.length) {
        logger.warn(
          { conversationId, messageId: m.id },
          'current-turn image fetch failed; degrading to text-only reply (no escalation, no handoff)',
        );
        unviewableImageMessageIds.add(m.id);
      }
    }
  }

  const prompt = buildPrompt({ salon, ctx, bookingLinkRecentlySent, imagesByMessageId, unviewableImageMessageIds });

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

  // The whole generation (LLM call -> strip leaked tool syntax -> recover
  // intent -> sanitize) runs inside an outer loop so a blank, no-intent
  // response can be retried once. GPT-4o intermittently returns text that
  // sanitizes to nothing with no tool call on very short affirmations ("yes",
  // "indeed") — a transient hiccup. Without the retry, that blank response
  // escalates a booking-intent customer straight to the owner (production
  // report 2026-07-10). Retry first; only escalate if the SECOND attempt is
  // also empty.
  let llmResult!: Awaited<ReturnType<typeof deps.llm.complete>>;
  let escalationArgs: { reason: string; contextSummary?: string } | undefined;
  let linkSentToolCalled = false;
  let leakedToolCalls: ReturnType<typeof extractLeakedToolCalls>['calls'] = [];
  let sanitized!: Awaited<ReturnType<typeof sanitize>>;
  let vocabLeakRetried = false;
  // Set only for the empty-output corrective retry: drop native tools on that one
  // attempt so a tool-happy model physically cannot fire another tool-without-text
  // and MUST produce a reply. Intent from the retry is still recovered via the
  // leaked-tool-call extractor, the handoff-promise net, and the booking-intent net.
  let forceTextRetry = false;
  // Intent recovered on an attempt that produced NO text, carried into the
  // corrective retry (which runs without tools and so cannot re-fire it).
  let carriedEscalationArgs: { reason: string; contextSummary?: string } | undefined;
  let carriedLinkIntent = false;
  const MAX_EMPTY_RETRIES = 1;
  // How long one llm_failed notification covers. A model outage hits every
  // inbound identically, so without this the owner gets an alert per message.
  const LLM_FAILED_DEDUP_MINUTES = 30;

  /**
   * We could not get usable reply text this turn. Answer from whatever intent we
   * already recovered, in descending order of how much the client was promised.
   *
   * Reached from two places: the model returned empty text twice, or the
   * corrective retry's API call failed. Both mean the same thing to the client,
   * and neither is an outage — so neither may be labelled as one.
   */
  const recoverWithoutText = async (why: string): Promise<void> => {
    const owner = salon.sourceOfTruth.salon_basics.owner_first_name;

    // Escalation intent first: the client was promised the owner, so the handoff
    // goes out under its ORIGINAL reason (refund, medical, ...) and is never
    // relabelled as a generic failure.
    if (escalationArgs) {
      logger.warn({ conversationId, why, reason: escalationArgs.reason }, 'no reply text; canned reassurance');
      sanitized = {
        messages: [`let me grab ${owner} for you, she'll jump in as soon as she's between clients 🤍`],
        modifications: ['escalation_fallback_text'],
      };
      return;
    }

    // Link intent without the URL — the confirmed 2026-07-10 failure: the model
    // fires mark_link_sent but writes nothing, so the client got no link at all.
    if (linkSentToolCalled || containsBookingIntent(lastInbound?.textContent)) {
      const recentlySent = linkSentToolCalled
        ? await eventsRepo.recentBookingLinkSent(deps.db, conversationId, salon.config.booking_link_dedup_window_hours)
        : bookingLinkRecentlySent;
      const linkMessage = recentlySent
        ? `the booking link I sent has all the latest openings 🤍`
        : `here you go 🤍 ${salon.sourceOfTruth.booking.url}`;
      logger.warn({ conversationId, why, recentlySent }, 'no reply text but booking intent; sending the link');
      sanitized = {
        messages: [linkMessage],
        modifications: [linkSentToolCalled ? 'link_intent_no_text_fallback' : 'booking_intent_no_text_fallback'],
      };
      return;
    }

    // Nothing to go on. The client still must not get silence, so a reassurance
    // line goes out and the normal post-send path escalates behind it.
    logger.warn({ conversationId, why }, 'no reply text and no intent; reassurance then escalating');
    sanitized = {
      messages: [`let me grab ${owner} for you, she'll jump in as soon as she's between clients 🤍`],
      modifications: ['sanitizer_empty_output_fallback_text'],
    };
    escalationArgs = { reason: 'sanitizer_empty_output' };
  };

  outer: for (let emptyAttempt = 0; ; emptyAttempt++) {
    // LLM call with exception-retry (up to 3 API failures -> llm_failed).
    let apiAttempts = 0;
    while (true) {
      try {
        llmResult = await deps.llm.complete({
          systemPrompt: prompt.systemPrompt,
          messages: forceTextRetry ? withoutImageBlocks(prompt.messages) : prompt.messages,
          tools: forceTextRetry ? [] : allTools,
          model: salon.config.llm_model ?? deps.defaultLlmModel,
          maxTokens: 512,
        });
        logger.info({
          conversationId,
          emptyAttempt,
          textLen: llmResult.text.length,
          textPreview: llmResult.text.slice(0, 200),
          toolCalls: llmResult.toolCalls.map((c) => c.name),
          inputTokens: llmResult.usage.inputTokens,
          outputTokens: llmResult.usage.outputTokens,
        }, 'llm response received');
        break;
      } catch (err) {
        apiAttempts++;
        const retryable = isRetryableLlmError(err);
        logger.warn({ err, apiAttempts, retryable, conversationId }, 'llm.complete failed');

        // Retry only transient failures. A bad key, a retired model, or an
        // exhausted quota fails identically every time, so three attempts just
        // add latency and noise to an outage a human has to fix.
        if (retryable && apiAttempts < 3) {
          // OpenAI states the exact wait in retry-after-ms on a rate limit.
          // Reading it beats guessing: a blind backoff that is a hair too short
          // burns all three attempts inside the same window for nothing.
          const delay = retryDelayMs(err, apiAttempts);
          logger.info({ conversationId, apiAttempts, delay }, 'retrying llm call');
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }

        // A failure on a RETRY is not an outage. The first call of this turn
        // already returned — the model answered, we only wanted better prose out
        // of it — so the client is owed the intent we recovered, not a technical
        // alert and a four-hour pause. Production 2026-08-08 and 2026-08-10: the
        // retry 429'd on the tokens-per-minute limit and a perfectly healthy
        // damage-photo lead was stamped `llm_failed` and frozen.
        if (emptyAttempt > 0) {
          logger.warn(
            { err, conversationId, emptyAttempt },
            'retry call failed after a successful first attempt; recovering from intent instead of escalating',
          );
          await recoverWithoutText('retry call failed');
          break outer;
        }

        // Terminal on the FIRST call: this really is the model being unreachable.
        // Dedup first: a broken account fails every inbound the same way, and one
        // red notification per client message buries the owner (production
        // 2026-07-22: nine in a day). Inside the window, stay quiet entirely —
        // the client already got a line and the owner already knows.
        const alreadyNotified = await eventsRepo.recentEscalationWithReason(
          deps.db,
          conversationId,
          'llm_failed',
          LLM_FAILED_DEDUP_MINUTES,
        );
        if (alreadyNotified) {
          logger.error(
            { err, conversationId },
            'llm call failed again within the dedup window; skipping duplicate escalation',
          );
          return { latestInboundAt: null };
        }

        // The client must not sit in silence while the owner is pulled in.
        // Route through the normal send path so the line is delivered, recorded,
        // and the escalation fires after it (same shape as the B5 fallback).
        logger.error({ err, conversationId }, 'llm call failed terminally; reassuring client then escalating');
        const owner = salon.sourceOfTruth.salon_basics.owner_first_name;
        sanitized = {
          messages: [`let me grab ${owner} for you, she'll jump in as soon as she's between clients 🤍`],
          modifications: ['llm_failed_fallback_text'],
        };
        escalationArgs = { reason: 'llm_failed' };
        break outer;
      }
    }

    // GPT-4o sometimes writes tool calls as literal "[tool(...)]" text, mimicking
    // the prompt's example notation, instead of firing native function calls
    // (production incident 2026-07-06). Strip that syntax so the client never
    // sees it, and keep the parsed calls so intent can be recovered below.
    const extracted = extractLeakedToolCalls(llmResult.text);
    const cleanedText = extracted.cleanedText;
    leakedToolCalls = extracted.calls;
    if (leakedToolCalls.length > 0) {
      logger.warn(
        { conversationId, leakedToolNames: leakedToolCalls.map((c) => c.name), textPreview: llmResult.text.slice(0, 300) },
        'LLM wrote tool-call syntax as reply text; stripped and recovering intent',
      );
    }

    // Fresh intent per attempt, EXCEPT anything carried over from an attempt
    // that produced intent but no text. The corrective retry runs with tools
    // disabled, so it cannot re-fire escalate_to_owner or mark_link_sent —
    // dropping the intent there would notify nobody about a refund the client
    // was already promised, or lose a link the model meant to send.
    escalationArgs = carriedEscalationArgs;
    linkSentToolCalled = carriedLinkIntent;

    // Collect tool intentions. Defer escalate_to_owner execution until AFTER send
    // so the LLM-generated reassurance text (e.g. "let me grab Sarah for you")
    // reaches the client before the tag flips and the bot goes silent.
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
      } else {
        // A tool name outside the three registered ones (hallucinated or drifted
        // prompt). Nothing to execute — log loudly so prompt drift is visible.
        logger.warn({ conversationId, toolName: call.name }, 'LLM called unregistered tool; ignoring');
      }
    }

    // Recover intent from text-form tool calls the model failed to fire natively.
    // The client already read the corresponding promise ("I'm letting Renata
    // handle this one"), so dropping the intent would strand the conversation.
    // Leaked args are model-authored text, so unlike native args they are only
    // trusted after validation: the reason must be one of the prompt's eight
    // enum values (otherwise client-quoted words could end up in the owner's
    // GHL last_escalation_reason field), and both named and positional arg
    // shapes are accepted since leaks mimic either notation.
    for (const leaked of leakedToolCalls) {
      if (leaked.name === 'escalate_to_owner') {
        if (!escalationArgs) {
          const rawReason = typeof leaked.named.reason === 'string' ? leaked.named.reason : leaked.positional[0];
          const reason =
            typeof rawReason === 'string' && LEAKED_ESCALATION_REASONS.has(rawReason) ? rawReason : 'unspecified';
          const rawSummary =
            typeof leaked.named.context_summary === 'string'
              ? leaked.named.context_summary
              : typeof leaked.positional[0] === 'string' && LEAKED_ESCALATION_REASONS.has(leaked.positional[0])
                ? leaked.positional[1]
                : undefined;
          escalationArgs = {
            reason,
            contextSummary: typeof rawSummary === 'string' ? rawSummary.slice(0, 300) : undefined,
          };
        }
      } else if (leaked.name === 'mark_link_sent') {
        linkSentToolCalled = true;
      } else if (leaked.name === 'set_state_flag') {
        const key =
          typeof leaked.named.key === 'string'
            ? leaked.named.key
            : typeof leaked.positional[0] === 'string'
              ? leaked.positional[0]
              : undefined;
        const value = leaked.named.value ?? (typeof leaked.positional[0] === 'string' ? leaked.positional[1] : leaked.positional[0]);
        if (key && value !== undefined && (ALLOWED_STATE_KEYS as readonly string[]).includes(key)) {
          await conversationsRepo.mergeState(deps.db, conversationId, { [key]: value });
        } else {
          logger.warn({ conversationId, key }, 'rejected unknown state flag from leaked text call');
        }
      }
      // Unknown names (e.g. the invented "get_started_link") need no recovery —
      // stripping the text was the whole fix; already logged above.
    }

    // Safety net for LLM tool-call reliability: if the model wrote handoff-promise
    // language ("let me grab Renata", "I'll let her know") but didn't fire
    // escalate_to_owner, force the escalation anyway. The customer was already
    // promised the owner is coming — failing to follow through breaks trust and
    // leaves the conversation silently un-handed-off.
    if (!escalationArgs && containsHandoffPromise(cleanedText, salon.sourceOfTruth.salon_basics.owner_first_name)) {
      logger.warn(
        { conversationId, textPreview: cleanedText.slice(0, 200) },
        'bot promised handoff in reply but did not call escalate_to_owner; forcing escalation',
      );
      escalationArgs = {
        reason: 'implied_handoff_no_tool_call',
        contextSummary: cleanedText.slice(0, 200),
      };
    }

    try {
      sanitized = await sanitize(cleanedText, {
        bookingLink: salon.sourceOfTruth.booking.url,
        properNouns: salonProperNouns(salon),
        policy: {
          maxWordsPerMessage: salon.config.max_words_per_message,
          maxEmojis: salon.config.max_emojis,
        },
      });
    } catch (err) {
      if (err instanceof SanitizerEmptyOutputError) {
        // Empty output. ALWAYS try a CORRECTIVE retry first, whatever intent the
        // model signalled: re-run the generation, tell it the last reply came
        // through blank, and drop its tools so it cannot fire another
        // tool-without-text. This addresses the root cause (a tool-happy model
        // that forgets to verbalize) and handles ANY intent naturally.
        //
        // Doing this BEFORE the canned fallbacks is QA item 4.1: three different
        // escalations (refund, medical, price contradiction) all shipped the
        // identical hardcoded sentence, and 17% of one day's replies were canned.
        // The fallbacks below are meant to be a rare backstop, not the voice —
        // a refund deserves refund-shaped warmth written by the model.
        if (emptyAttempt < MAX_EMPTY_RETRIES) {
          // Carry the intent: the retry has no tools, so it cannot re-signal an
          // escalation the client was already promised or a link it meant to send.
          carriedEscalationArgs = escalationArgs;
          carriedLinkIntent = linkSentToolCalled;
          // Corrective retry. forceTextRetry drops native tools on the next attempt
          // so a tool-happy model cannot fire another tool-without-text and MUST
          // write a reply — far more reliable than prose alone. The nudge is worded
          // so that even if the model mirrored it, no machinery vocabulary reaches
          // the client. Append to the last user turn rather than pushing a second
          // consecutive user message (some providers dislike consecutive same-role).
          const nudge =
            '(Reminder: your last turn produced no reply text. Write your reply to the last message now, in plain words, following every rule above.)';
          const last = prompt.messages[prompt.messages.length - 1];
          if (last && last.role === 'user' && typeof last.content === 'string') {
            last.content = `${last.content}\n\n${nudge}`;
          } else {
            prompt.messages.push({ role: 'user', content: nudge });
          }
          forceTextRetry = true;
          logger.warn({ conversationId, emptyAttempt }, 'llm produced empty output; corrective retry (tools dropped, text forced)');
          continue outer;
        }
        // The model produced no text even with the nudge and its tools taken
        // away. Answer from the intent we already have.
        await recoverWithoutText('double empty output');
        break outer;
      }
      throw err;
    }

    // 1.9 tripwire — internal-vocabulary / machinery-narration net (defense in
    // depth behind Section 12 of the prompt). extractLeakedToolCalls already
    // stripped bracketed tool SYNTAX; this catches PLAIN-ENGLISH machinery the
    // model narrates to the client ("I'll note this as the last quoted service",
    // "let me flag her for the owner") and bare internal terms. Casual style has
    // few sentence boundaries, so surgically excising the offending clause is
    // unreliable — instead regenerate a clean reply. If a leak survives the
    // retry, discard the leaky text entirely: send a reassurance line and hand
    // off for human review rather than let the client read the bot's plumbing.
    const vocabLeak = matchInternalVocab(sanitized.messages.join('\n'));
    if (vocabLeak) {
      if (emptyAttempt < MAX_EMPTY_RETRIES) {
        vocabLeakRetried = true;
        // Same token discipline as the empty-output retry. Without this the
        // regeneration re-sends every image, putting ~18k tokens back on the
        // wire a second later and reproducing the 429 that the strip-images fix
        // exists to prevent — only through this door instead.
        carriedEscalationArgs = escalationArgs;
        carriedLinkIntent = linkSentToolCalled;
        forceTextRetry = true;
        logger.warn(
          { conversationId, matched: vocabLeak, textPreview: sanitized.messages.join(' ').slice(0, 300) },
          'internal-vocabulary leak in client reply; regenerating (1.9 tripwire)',
        );
        continue outer;
      }
      logger.error(
        { conversationId, matched: vocabLeak, textPreview: sanitized.messages.join(' ').slice(0, 300) },
        'internal-vocabulary leak persisted after retry; reassurance + escalate (1.9 tripwire)',
      );
      const owner = salon.sourceOfTruth.salon_basics.owner_first_name;
      sanitized = {
        messages: [`let me grab ${owner} for you, she'll jump in as soon as she's between clients 🤍`],
        modifications: [...sanitized.modifications, 'internal_vocab_leak_fallback'],
      };
      escalationArgs = escalationArgs ?? { reason: 'internal_vocab_leak' };
    }
    break outer;
  }

  // Record the strip in sanitize_mods so leaked-syntax turns are queryable
  // (ai_raw_output keeps the original text as evidence).
  if (leakedToolCalls.length > 0) {
    sanitized.modifications.push('tool_call_text_stripped');
  }
  // A leak the retry cleaned up leaves no trace in the final text; record it in
  // sanitize_mods so leak turns stay queryable even when recovery succeeded.
  if (vocabLeakRetried && !sanitized.modifications.includes('internal_vocab_leak_fallback')) {
    sanitized.modifications.push('internal_vocab_leak_retried');
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
        // llmResult is unset when the API call itself never succeeded (the
        // llm_failed path still sends the client a line), so read it defensively.
        aiRawOutput: llmResult?.text ?? null,
        sanitizeMods: sanitized.modifications,
        promptTokens: llmResult?.usage.inputTokens ?? 0,
        completionTokens: llmResult?.usage.outputTokens ?? 0,
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
      return { latestInboundAt: null };
    }
  }

  // Record which inbound this reply answered, so the answered-guard on a later
  // run knows everything up to here is handled (B6 double-reply prevention).
  await eventsRepo.insert(deps.db, conversationId, 'replied', {
    answeredInboundAt: latestInboundAt.toISOString(),
  });

  // Record booking_link_sent event AFTER successful send so the dedup window starts
  // from the next turn, not the current one. Either the LLM declared intent via
  // mark_link_sent or post-sanitize scan found the link in final output.
  // This runs BEFORE the escalation branch: a turn that both sends the link and
  // escalates must still start the dedup window, or the bot re-pastes the link
  // to the same client once the handoff expires.
  const containsLink = sanitized.messages.some((m) => m.includes(salon.sourceOfTruth.booking.url));
  if (linkSentToolCalled || containsLink) {
    await eventsRepo.insert(deps.db, conversationId, 'booking_link_sent', {});
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
  }

  // Replied successfully. If we escalated, the bot is now paused so a re-drive
  // would just be dropped — return null. Otherwise hand the watermark back so
  // the worker re-enqueues if a newer message arrived mid-processing (B6).
  return { latestInboundAt: escalationArgs ? null : latestInboundAt };
}
