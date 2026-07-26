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
import { isRetryableLlmError } from '../llm/is-retryable.js';
import { buildPrompt } from '../prompt/build.js';
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

  outer: for (let emptyAttempt = 0; ; emptyAttempt++) {
    // LLM call with exception-retry (up to 3 API failures -> llm_failed).
    let apiAttempts = 0;
    while (true) {
      try {
        llmResult = await deps.llm.complete({
          systemPrompt: prompt.systemPrompt,
          messages: prompt.messages,
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
          await new Promise((r) => setTimeout(r, 500 * 2 ** apiAttempts));
          continue;
        }

        // Terminal. Dedup first: a broken model account fails every inbound the
        // same way, and one red notification per client message buries the owner
        // (production 2026-07-22: nine in a day). Inside the window, stay quiet
        // entirely — the client already got a line and the owner already knows.
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
        // Everything below is the double-empty case: the model produced no text
        // even with the nudge and its tools taken away. Now, and only now, do the
        // canned lines fire.
        //
        // Escalation intent first — the client was promised the owner, so the
        // handoff must go out with its ORIGINAL reason (refund, medical, ...),
        // not be relabelled as a generic empty-output failure.
        if (escalationArgs) {
          const owner = salon.sourceOfTruth.salon_basics.owner_first_name;
          const fallback = `let me grab ${owner} for you, she'll jump in as soon as she's between clients 🤍`;
          logger.warn(
            { conversationId, reason: escalationArgs.reason },
            'escalation intent with no text after corrective retry; sending canned reassurance',
          );
          sanitized = { messages: [fallback], modifications: ['escalation_fallback_text'] };
          break outer;
        }
        // Link intent without the URL — the confirmed 2026-07-10 failure: on
        // booking messages GPT-4o fires mark_link_sent and set_state_flag but
        // writes no text, so the client got nothing. Paste the link ourselves.
        if (linkSentToolCalled) {
          const bookingUrl = salon.sourceOfTruth.booking.url;
          const recentlySent = await eventsRepo.recentBookingLinkSent(
            deps.db,
            conversationId,
            salon.config.booking_link_dedup_window_hours,
          );
          const linkMessage = recentlySent
            ? `the booking link I sent has all the latest openings 🤍`
            : `here you go 🤍 ${bookingUrl}`;
          logger.warn(
            { conversationId, recentlySent },
            'llm signaled link intent with empty text after corrective retry; sending booking link fallback',
          );
          sanitized = { messages: [linkMessage], modifications: ['link_intent_no_text_fallback'] };
          break outer;
        }
        // Last-resort net for B4: if the client clearly asked to book, send the
        // link rather than hand a converting client to a 4h handoff. Anchored
        // keywords are a COARSE net
        // here by design — the corrective retry already covers the vast majority of
        // phrasings, so this only has to catch the common ready-to-book lines in the
        // rare double-empty case. Reads only the client message, never a tool call.
        if (containsBookingIntent(lastInbound?.textContent)) {
          const bookingUrl = salon.sourceOfTruth.booking.url;
          const linkMessage = bookingLinkRecentlySent
            ? `the booking link I sent has all the latest openings 🤍`
            : `here you go 🤍 ${bookingUrl}`;
          logger.warn(
            { conversationId, recentlySent: bookingLinkRecentlySent },
            'empty text on a ready-to-book message after corrective retry; sending booking link fallback (B4)',
          );
          sanitized = { messages: [linkMessage], modifications: ['booking_intent_no_text_fallback'] };
          break outer;
        }
        // Empty again after the corrective retry, no booking intent. We escalate,
        // but the client must NOT get pure silence (production 2026: a client
        // pointing out a price contradiction got dead air here). Send a reassurance
        // line first, then let the normal post-send path fire the escalation.
        logger.warn({ conversationId }, 'llm produced empty output again after corrective retry; sending reassurance then escalating');
        const owner = salon.sourceOfTruth.salon_basics.owner_first_name;
        sanitized = {
          messages: [`let me grab ${owner} for you, she'll jump in as soon as she's between clients 🤍`],
          modifications: ['sanitizer_empty_output_fallback_text'],
        };
        escalationArgs = { reason: 'sanitizer_empty_output' };
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
