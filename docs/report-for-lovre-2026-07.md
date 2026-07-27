# Backend-side report — July incident + answers to the [CONFIRM] items

To: Lovre
From: backend (Ivan)
Date: July 2026 (updated through July 26)

## 1. Correcting the incident diagnosis (Bible, Sections 2.7 and 0)

The Bible claims the live issue is a "Fable regeneration referencing a non-existent tool"
and that the urgent action is "redeploy CURRENT.md". Forensics from the production database
say otherwise:

- **The deployed prompt IS your `Fillchair_Master_Prompt_CURRENT.md`** — not a regeneration.
  The only differences are three documented technical adaptations (point 4 below).
- **`get_started_link` exists nowhere** in the deployed prompt or the SOT (verified by grep).
  GPT-4o invented it at runtime. Redeploying the same file changes nothing.
- Booking turn (Jul 6, 19:02 UTC): the native `mark_link_sent()` **DID fire** (the event
  exists in the DB) — the model called the real tool AND printed `[get_started_link()]` as
  text at the same time.
- Slur turn (Jul 6, 19:04 UTC): the native `escalate_to_owner` **did NOT fire** (no
  escalation row, no event, the bot was not paused). The model printed the entire call as text.

**Real root cause:** GPT-4o occasionally imitates the bracket notation from the EXAMPLES
section (`[mark_link_sent()]` under each example) and prints it as part of the reply, instead
of (or alongside) the native function call. The same failure mode happened in June (handoff
promised, empty toolCalls, no brackets) — so it is chronic tool-calling instability, not a v3
regression. On your "voice degradation" claim: the "Hey there! What's up? 😊" message from
Jul 4 went through the OLD prompt (v3 shipped Jul 5) — there is no template/greeting path in
the backend, everything goes through the master prompt.

## 2. What the backend implemented (Jul 10)

Exactly what the Bible asks for in Sections 10 and 12, plus intent recovery:

1. **Bracket-strip with intent recovery**: every `[tool(...)]` pattern in the LLM text is
   parsed and removed before sending. If `escalate_to_owner` leaked as text but the native
   call did not fire → the backend **force-escalates with the parsed reason** (the client was
   already promised it). A leaked `mark_link_sent` → the event is still recorded (dedup does
   not break). A leaked `set_state_flag` → state is merged (using the existing key allowlist).
   Unknown names (e.g. `get_started_link`) → strip + warn log only. `sanitize_mods` gets
   `tool_call_text_stripped`, so these turns are queryable.
2. **The orchestrator warn-logs native calls to unknown tools** (it does not execute them).
3. **Extended handoff-promise detector** (a pre-existing backend safety net): now also catches
   "I'm letting Renata handle this one" (the exact production miss) and "Imma let [owner] take
   this one" (your example from Section 14!).
4. **Prompt hardening** — the following paragraph was added to Section 12 (TOOL USAGE); per the
   layer-sync rule (Section 13.2) you MUST backport it into the Layer 1 generator and CURRENT.md:

   > The bracketed notation you see in this prompt's examples, like [mark_link_sent()] or
   > [escalate_to_owner(...)], is documentation shorthand for INVISIBLE native function
   > calls. It is never part of the reply. Never write that notation, any bracketed
   > function name, or any tool syntax in your reply text. Your text contains only the
   > words the client reads. Fire tools exclusively through the function-calling
   > interface, and only the three tools below exist — never invent a tool name.

## 3. Answers to the [CONFIRM] items (Bible 0.5)

- **#2 State lines: SHIPPED (Jul 5).** "Hours since last client message" is always sent when a
  previous message exists (measured from the START of the batched burst, so 3 quick messages
  after 2 days of silence report ~48, not 0). "Current date and time (salon local)" is sent
  when the salon has a `timezone` set (IANA, a new config field; Lumen = Europe/Zagreb).
  Without a timezone the line is omitted — the prompt degrades safely, by design.
- **#3 `service_menu.not_offered`: SHIPPED (Jul 5).** Optional array of strings, defaults to
  empty when `service_menu` exists; old SOTs without the field still validate. The Lumen test
  SOT has it populated: nails, lashes, makeup, brows, perms, barbering.
- **#4 Dedup N: NOT a message count — a 24-hour time window.** Changed Jul 5 at the owner's
  request (a conversation older than 24h should get the link again). The state line and the
  sanitizer read the SAME config field (`booking_link_dedup_window_hours`, default 24), so
  divergence is impossible. Update contract 5.3/5.6 and the glossary ("Dedup window (N)").
- **#5 Default handoff window: 4 hours** (`handoff_window_hours`, per-salon config).
- **#6 Exact format of the state block as the backend prints it:**

  ```
  # Conversation state
  - Booking link sent recently (within last 24h): false
  - Total inbound messages this conversation: 5
  - State flags JSON: {"client_is_hesitant":true,"last_quoted_service":"Full Balayage"}
  - Current date and time (salon local): Friday, July 10, 2026, 3:45 PM
  - Hours since last client message: 26
  ```

  The last two lines are optional (see #2).

## 4. Deviations of the deployed prompt from your CURRENT.md (backport into the generator!)

1. **Emoji encoding**: your file arrived with corrupted bytes (`ð¤` instead of 🤍) — fixed at
   deploy. Check the encoding on your next export.
2. **Dedup line label**: "Booking link sent in last N messages" → **"Booking link sent
   recently"** (Section 2 heading + Section 7 reference), aligned with the time-based state
   line (#4 above).
3. **Anti-dangling-colon rule** (Section 2): when the link was recently sent, the model must
   not write a "phrase: [URL]" construction, because the sanitizer strips the URL and a dangling
   colon is left behind (a June production bug). Added next to the "sent recently" rule.
4. **Anti-leak paragraph** in Section 12 (point 2.4 above).

Without backporting these changes, the next regeneration from Layer 1 silently deletes them —
exactly the June drift scenario your Section 13 forbids.

## 4b. Follow-up finding (Jul 10–11): mark_link_sent with no text

A production log confirmed a separate but related failure. On booking messages
("i want to book an apointment") GPT-4o returns `textLen:0` alongside
`toolCalls:["mark_link_sent","set_state_flag"]` — i.e. **it calls the tool to send the link
but writes no text at all** (does not paste the URL). Result: the client gets nothing, and the
backend (before the fix) escalated every such turn -> the bot froze in an escalation loop. This
was NOT an LLM connectivity problem (75/78 responses have real text, zero `llm_failed`) nor a
second bot on the page (confirmed: that "Hello, sure we can do that" message was the owner
typing manually).

Backend fix (reliable, in our control): when the output is empty but `mark_link_sent` was
called -> the backend pastes booking.url itself (or a gentle nudge if the link was already sent
within the dedup window), instead of escalating. Plus one retry on every empty, no-intent output
before escalating.

For backport into the Layer 1 generator (Section 12, mark_link_sent): added a rule that the tool
ONLY records the send and does NOT put the URL in the message — the URL must be in the reply
text, otherwise the client gets nothing. This reduces the failure rate at the source; the
backend fix stays as the net below.

## 4c. Follow-up finding (Jul 11): dedup was stripping the link re-paste

Production: the client says "i do not see it", the model CORRECTLY re-pastes booking.url, but
the sanitizer's across-turn dedup (`booking_link_deduplicated`) strips it because the link was
sent < 24h earlier -> the client gets a broken message "here it is again for you: Happy
booking!" with no URL. Confirmed by a raw-vs-sent comparison (raw had the URL, sent did not,
mods = booking_link_deduplicated).

Backend fix: **removed the across-turn booking-link dedup from the sanitizer.** When the model
includes the link, it passes through. The "re-paste vs refer conversationally" decision belongs
to the prompt (the state block still tells the model the link was sent recently), not the
sanitizer. Bonus: this also retires the old dangling-colon bug (the URL now stays instead of
being stripped).

For backport into the Layer 1 generator (Sections 2 and 7): the "booking link sent recently"
rule was reworded — for an incidental mention, refer to it conversationally, BUT **re-paste the
full URL when the client can't find the link, asks for it again, or is actively trying to book**
("i do not see it", "send it again", "which one", "can i book"). Removed the stale sentence "the
sanitizer strips any repeated paste" (the sanitizer no longer does that).

## 4d. QA Round 1 — Part 1 prompt fixes (for Layer 1 backport)

I did all the Part 1 items from the QA report in the deployed master-prompt.md. Adversarially
verified (an 11-agent workflow): all 15 items solidly covered, and it caught 3 regressions the
new rules created in existing examples (fixed). For backport into the Layer 1 generator:

- **1.2** — added "happy to help", "Hey there", "It sounds like you're asking", "Thanks for
  sharing" to Forbidden phrases; a new "Never restate the question" subsection.
- **1.3** — Photo "You do": you must name ONE concrete observed detail from THAT image (a
  generic line that fits any picture = BAD); + a BAD example.
- **1.4/1.5** — Section 1: a global rule "every example is a PATTERN, not a script; vary it each
  time; never the same sentence twice; answer the EXACT identity question asked".
- **1.6** — Section 3: "Never state a policy that is not in the knowledge base" (strictest on
  liability topics: minors/parental consent, allergies, pregnancy) → route to the consult; + a
  BAD example (parental consent). ("Of course" was already a banned opener.)
- **1.7** — Section 3 not_offered: a warm-no does NOT get the booking link (no bookable intent).
- **1.8a** — Section 11 "Do not escalate for": a clear ready-to-book signal ("book me in") NEVER
  escalates → warmth + link + clear client_is_hesitant; + a BAD example.
- **1.8b** — Section 2 One voice: the client points out a contradiction → one warm line +
  escalate unanswered_question, NEVER silence.
- **1.8c/d/e** — Section 14: "Never repeat the same deflection twice" (a second push →
  unanswered_question); "Phishing, scam, and impersonation" (light redirect, NEVER escalate);
  "Vendor, marketing, and partnership pitches" (one close, no loop).
- **1.8f** — Section 8 "Story and reel context": handle the [client shared one of your reels]
  marker, never echo it back to the client. (See B7 below — the marker stays inactive because
  the backend cannot decode a reel; escalation is used instead.)
- **1.8g** — Section 1: lowercase-casual style locked in.
- **1.9 (P0)** — Section 12: "Never narrate your own machinery, in brackets OR in plain English"
  (never note/log/save/flag/mark/track/escalate talk, never internal words state/flag/last
  quoted service/reason code). Section 9: a number with no context → tie it to
  last_quoted_service or ask, NEVER reverse-match to a price from the SOT; + BAD examples.

The backend half of 1.9 (the tripwire) and 1.8b (sanitizer_empty_output sends a reassurance)
work independently of the prompt — see Sections 4e and 4f.

## 4e. QA backend block B3–B7 (10 fixes; one prompt change to backport)

Completed backend blockers B3–B7 (adversarially reviewed — the review caught a serious B6
concurrency bug that was fixed with the answered-guard):

- **B5** — an empty output with no intent no longer goes to silence: it sends a reassurance
  line and then escalates (`sanitizer_empty_output`).
- **B3** — an image failure in the current turn no longer escalates + pauses the bot for 4h; it
  degrades to a text reply. Backend: the whole trailing inbound burst is flagged, `process.ts`
  throws typed errors, `respond.ts` wraps in try/catch so a throw never wedges the conversation.
  **PROMPT (for Layer 1 backport, Section 8):** added a rule for the `[photo not received]`
  marker — when present, the client sent a photo that could not be opened; handle it as the
  attachment-not-visible case (warmly ask for a resend, answer any caption, never mention the
  technical problem or the marker itself). The backend injects that marker when fetch/decode
  fails.
- **B6** — text+photo coalescing race (the photo was stranded because the job was still active):
  the worker returns a watermark of the loaded messages and re-enqueues a drain job if a new
  message arrived mid-processing. The key safety property: an **event-based answered-guard** —
  after every successful reply we write a `'replied'` event with the timestamp of the newest
  inbound that reply addressed; the drain skips only if the newest loaded inbound is ≤ the last
  addressed one. (The first version used "the last message is outbound" — the review proved that
  wrongly skips the very stranded message the drain exists to deliver, because a reply is always
  timestamped AFTER a mid-processing inbound. Fixed.)
- **B7 — resolved: a shared reel → escalation to the owner (`unviewable_media`).**
  Discovery (via `.passthrough()`): for a shared reel, GHL renders **all three merge tags empty**
  (`{{message.body}}`, `{{message.attachments}}`, `{{message.subject}}`) — the content is lost at
  GHL/Meta ingestion, so we can **neither decode nor render** the reel. Empirically confirmed that
  IG likes/reactions do **not** fire the webhook, so a bare webhook reliably means a real content
  share (reel / story reply / view-once), not noise. Therefore: empty text + no attachments +
  `attachments_raw` present → classified as `unviewableMedia` → **escalate to the owner**
  (consistent with `video_attachment` / `audio_attachment`). It passes through the existing
  handoff guard (self-limiting: the first such message escalates, later ones within the 4h window
  hit the guard). Prompt note: the `[client shared one of your reels]` marker (1.8f) **stays
  inactive** — we cannot confirm it is specifically a reel (it looks identical to a story /
  view-once), so we use a safe generic escalation instead of injecting the marker.

## 4f. 1.9 backend tripwire — internal-vocab denylist (P0)

The backend net behind the prompt rule from Section 12 ("Never narrate your own machinery").
`extractLeakedToolCalls` already strips **bracket syntax** (`[mark_link_sent()]`); this catches
the **plain-English machinery** that syntax stripping does not see: "I'll note this as the last
quoted service", "flagging this for the owner", "putting this in the system", + internal terms
(state flag, reason code, escalate_to_owner).

- **Module** `src/sanitizer/internal-vocab.ts` — a denylist of tight, scoped regexes
  (first-person/gerund for bookkeeping verbs, object-scoped, owner-scoped for routing) so casual
  speech ("noted 🤍", "mark your calendar", "flag her down", "hand off your color to a stylist",
  "before things escalate") does NOT trip the tripwire.
- **Behavior** (`generate-response.ts`): on a match → **regenerate the reply once** (sharing the
  `MAX_EMPTY_RETRIES` budget). If a leak survives the retry → the leaky text is **discarded**, a
  reassurance line is sent + `escalate_to_owner(internal_vocab_leak)`. The client never sees the
  machinery. A leak the retry cleaned up is recorded in `sanitize_mods`
  (`internal_vocab_leak_retried`) for queryability.
- **Adversarially reviewed** (two lenses): the review confirmed the wiring is correct and found
  4 false positives + gerund false negatives (`noting your interest`, `flagging this for the
  owner` — both named verbatim in Section 12) — all fixed; a corpus of 52 tests (29 leak + 23
  legit phrases) guards against regressions in both directions.

## 4g. Follow-up finding (Jul 16): the bot re-pasted the booking link every turn

Production (Lumen test conversation): the bot pasted the full booking URL on nearly every turn —
price, hesitance, consult, photo — 12+ times in one conversation, which reads as robotic spam.

Diagnosis (DB-confirmed, NOT a backend bug): the "Booking link sent recently" state was computed
correctly and was TRUE on every one of those turns (`recentBookingLinkSent` over the 24h window),
and the model **ignored it**. Root cause is a prompt-design tension: ~15 rules mandate the link
("Send the link on turn 1, always", price policy "b" = range then consult *with the link*,
hesitance/photo/availability/damage all include booking.url, and every example pastes it), while
the single counter-rule was weak and self-undermining — "you *usually* do not need to paste... for
an *incidental* mention... **When in doubt, paste it.**" The model resolved the conflict toward
pasting every time. There is no backend net because the sanitizer's across-turn link dedup was
removed in 4c (it broke legitimate re-pastes and caused a dangling-colon bug).

Fix (prompt only, for Layer 1 backport): made the "sent recently" rule dominant. When true, do NOT
paste the URL again — refer to it conversationally on any turn where you would otherwise include it
(price, consult, hesitance, photo, damage, availability). Removed "When in doubt, paste it". The
exception is an explicit request to see/resend the link ("i do not see it", "send it again") or a
functional action the client was not already pointed to (cancel/reschedule); a ready-to-book signal
("book me in") is NOT a link request — point them back to the one already sent (consistent with
Section 11). Turn-1 behavior (sent recently = false → paste fresh) is unchanged.

An adversarial two-lens review of this change flagged that the prose was strengthened but the
example bank still taught only pasting (zero examples of the new conversational-reference behavior)
— the likely reason the model ignored the TRUE state in production. So the fix touches more than
Sections 2 and 7: added three worked examples (repeat-turn conversational reference, ready-to-book
point-back, explicit re-paste), a caveat on the photo rule (Section 8), a cross-reference on the
price policies (Section 9), and closed a 12h-vs-24h dead zone (a 12h+ gap now also resets "link not
recently sent" so a returning client gets a fresh paste). Backport ALL of these. Note: GPT-4o
adherence is not 100%; a backend dedup net remains possible but is deferred (the dangling-colon risk
is why it was removed in 4c).

## 4h. B4 closed — "book me in" escalated instead of sending the link

Production DB proof (Jul 16): client "You know what, im ready, book me in" -> the model returned
EMPTY reply text but completion=39 tokens, i.e. it fired a tool (almost certainly
set_state_flag(client_is_hesitant,false), which the prompt tells it to do on a ready-to-book
signal) and wrote no text and did NOT fire mark_link_sent. The empty-output path then retried, got
empty again, and escalated with reason sanitizer_empty_output + a "let me grab Renata" reassurance.
So a converting client got a 4h handoff instead of the booking link — B4, the worst outcome at the
moment of conversion. The prompt defense (1.8a "ready-to-book never escalates") does not help here
because the model never explicitly escalated; it fell through the empty-output net.

Fix (backend), general — a CORRECTIVE retry. The root cause is a tool-happy model that fires a tool
and forgets to verbalize, so the fix makes the model write the reply rather than guessing intent.
The empty-output path already retried once; that retry is now corrective: on empty output it appends
a short nudge ("your last turn produced no reply text, write your reply now") AND drops native tools
for that one attempt (forceTextRetry) so the model physically cannot fire another tool-without-text
and MUST produce a reply. This handles ANY intent/phrasing naturally — booking, price, hesitance —
with no keyword list, and addresses the root instead of the symptom. Escalation/link intent from the
retry is still recovered via the leaked-tool-call extractor, the handoff-promise net, and the
booking-intent net.

Only if the corrective retry ALSO comes back empty (rare) does a coarse last-resort net apply: if the
client's last message is a clear ready-to-book signal (`containsBookingIntent`, new
src/core/detect-booking-intent.ts — ANCHORED phrases only, with leading-negation / trailing-deferral
vetoes, reading ONLY the client message, never a tool call), send the booking link; otherwise
reassurance + escalate (preserving the B5 hard-message handoff). Because the corrective retry handles
the vast majority, the keyword net's brittleness no longer matters — it is a rare backstop, not the
primary decision.

Adversarially reviewed across three workflows (false-positive-surface, wiring, and corrective-retry
loop-safety/behavior). Key review-driven decisions: a tool-based booking signal was DROPPED (it trusts
the model's flag inference on the very turn it malfunctioned); the negation veto was anchored to the
immediately-preceding token; and the decisive reliability fix — dropping native tools on the retry —
came from the behavior lens (prose alone does not stop a tool-happy model from firing another empty
tool call). Backend-only; no prompt or Layer 1 change needed for B4.

## 4i. Round 2 blocker `llm_failed` — root cause, and a latent bug it exposed

**Root cause: the OpenAI account ran out of credit.** Not per-conversation poisoning. The DB is
unambiguous: 21 Jul had 49 inbound / 41 replies, then the last successful reply was 21 Jul 17:52:44
and from that moment EVERY call failed — across three different contacts, on plain text messages
("hey, quick question"), in threads containing no media at all. A global account-level failure, not
a per-thread one. Confirmed by the owner topping the balance back up. (The tester's "clusters after
escalations" reading was a scheduling coincidence: the escalation tests happened to run right as the
balance ran out.) F13's "silent death" is the same event downstream — an `llm_failed` escalation
sets the 4h handoff, so the next message is silently paused by design.

That said, the outage exposed four real weaknesses that would repeat on the next quota/key failure.
All four are now fixed, so the next model outage degrades quietly instead of melting down:

0. **Silence to the client (fixed).** `llm_failed` escalated without sending anything, so the client
   sat in dead air. It now routes through the normal send path: the client gets the reassurance line
   first, then the escalation fires — the behaviour Section 1 of the QA report asks for.
1. **Alert storm (fixed).** Nine escalations in one day, one per message. `llm_failed` is now deduped
   per conversation over a 30-minute window: the first failure notifies the owner and answers the
   client, repeats inside the window are handled silently. The owner never gets a red alert because
   a client said hi.
2. **Pointless retries (fixed).** The LLM call was retried 3× on ANY exception, including
   deterministic ones (401 invalid key, 404 retired model, exhausted quota — which arrives as a 429
   but never clears). Retries are now limited to transient failures: network/timeout, 5xx, and
   genuine rate limiting. The 21 Jul outage burned three calls per inbound for nothing.
3. **Empty prompt turns (fixed).** A media-only message is stored with `text_content = NULL`,
   and the prompt builder rendered it as `{ role: 'user', content: '' }` — which OpenAI and Anthropic
   both reject. Since the row stays in the loaded window, this WOULD have poisoned every later call on
   that conversation until it scrolled out. It was not the cause of this outage, but it was a live
   landmine: 39 such rows exist in production.

Fix for (3) plus **a PROMPT change to backport (Section 8)**: media-only turns now render as a plain
marker instead of empty content, and `buildPrompt` will never emit an empty turn on either side.
Markers: `[client sent a video]`, `[client sent a voice note]`, `[client sent an attachment that did
not come through]` (the shared-reel / view-once case), alongside the existing `[photo not received]`.
The new Section 8 rule tells the model these are notes to itself: never repeat a marker back, never
claim to have watched/heard/seen the media, never name a technical limitation, and move the
conversation forward by asking what the client is after.

### What GHL actually delivers for Instagram media (verified against production payloads)

| Client sends | Reaches the backend? | Evidence |
|---|---|---|
| Photo | YES, with a URL | `attachments:[{url:".../*.jpeg", type:"image"}]` |
| **Video** | **YES, with a URL** | `attachments:[{url:".../*.mp4", type:"video"}]` |
| GIF | YES, as an image URL | `.gif` typed `image` |
| **Shared reel** | **NO** | `attachments: []` — GHL drops reel content at ingestion; it renders as an empty bubble in GHL's own inbox too |
| View-once photo | NO | Meta does not deliver it at all |

So real video understanding is achievable today with no GHL work — the URL is already in hand; we
currently hard-escalate video by design, not because the media is missing. Shared reels are the only
case that is genuinely unrecoverable through GHL, which is why they escalate to the owner.

Note for Meta-level context: Meta's messages webhook HAS supported `ig_reel` attachments (with url,
title, reel_video_id) since ~June 2024, so the reel content exists one layer up — GHL simply does not
surface it. Voice notes arrive as `.mp4`, which is why our URL-extension heuristic mislabels them as
`video_attachment` (QA item 3.2); distinguishing them needs a `Content-Type` check.

## 4j. QA 4.1 and 4.2 are the SAME backend bug, not a prompt regression

Round 2 filed these as two separate prompt problems: escalations shipping identical text (4.1), and
the hesitant first-timer "losing all empathy" (4.2). Both are one backend behaviour.

The evidence is the literal strings. E2/E4/E5 all produced *"let me grab Renata for you, she'll jump
in as soon as she's between clients 🤍"*, and E1 produced *"here you go 🤍 [link]"* and then *"the
booking link I sent has all the latest openings 🤍"*. Those are our HARDCODED fallbacks, character
for character. They only fire when the model returns no reply text at all. So the prompt never
regressed: what the tester graded as a voice regression was the model going silent and our canned
line speaking for it. Production data backs this up — on 21 Jul, 7 of 41 replies (17%) were canned.

Root cause: on empty output, the branches for "escalation intent" and "link intent" short-circuited
straight to a canned line. They were designed as a rare backstop and became the default voice.

Fix: the corrective retry now runs FIRST for every empty output, whatever intent was signalled. The
retry re-runs the generation with a short nudge and with native tools disabled, so a tool-happy model
cannot fire another tool-without-text and has to write a reply. Intent from the first attempt is
carried across (the retry has no tools, so it cannot re-signal an escalation the client was already
promised or a link it meant to send), and if the escalation still has to fall back to the canned line
it keeps its ORIGINAL reason instead of being relabelled a generic empty-output failure.

Result: a refund gets refund-shaped warmth, a medical question gets its own, and the hesitant
first-timer gets empathy plus consult framing — all written by the model, with the canned lines back
to being the rare backstop they were meant to be. No prompt or Layer 1 change is needed for 4.1/4.2.

## 4k. Round 2 prompt fixes (for Layer 1 backport)

Applied to the deployed master-prompt.md. Items 4.1, 4.2 and 4.9 are NOT here — 4.1/4.2 turned out
to be the backend bug in 4j, and 4.9 was never exercised because of the outage.

- **4.3 — video admission (Section 8).** The rule existed but only half of it was being followed, so
  the ban is now explicit and has a BAD example: never state, imply, or apologize for not having
  received, seen, watched, heard, or been able to open anything, not even softened with "but". Go
  straight to the redirect with no preamble about what did or did not arrive.
- **4.4 — menu dump (Section 3).** New rule: on a broad "what do you offer", name two or three
  categories at most in your own words and hand back one question. Never list the inventory — it
  reads like a brochure and buries what the client actually wants.
- **4.5 — fabricated people, past, and payment (Section 3).** The existing "never state a policy
  that is not in the knowledge base" rule now explicitly covers three areas where invented answers
  sound most convincing. Never say anything in either direction about a person who is not in
  stylist_directory (the bot told a client "petra isn't here anymore", confirming employment history
  for someone who never existed); never assert any past fact not in the knowledge base; never extend
  a payment fact beyond what is written (it claimed "card or cash accepted" — the SOT says only that
  a card on file is required, and the word "cash" appears nowhere in it). BAD/GOOD example included.
- **4.7a — openers and repetition (Section 4).** "Hi there" and "Hello there" joined "Hey there" on
  the forbidden list, plus a new "Never reuse your own phrasing" rule: never repeat a sentence
  already sent in the conversation and never open two consecutive replies the same way, with the
  booking-page description called out by name (it appeared near-verbatim in two consecutive replies).
- **4.8 — capitalization (Section 1).** The lowercase rule was soft ("default to lowercase") and the
  model drifted back to sentence case. Now: start EVERY sentence lowercase, including the first word
  of every message, with only proper nouns, prices, and "I" capitalized, plus worked right/wrong
  examples.

Not prompt items, tracked separately: 4.6 (message splitting is our sanitizer's word cap, pending a
product decision) and the improvised hyphen in 4.7 (our sanitizer rewrites an em dash to "-", which
is what produced "availability-just").

## 4l. Round 2 backend items 3.1, 3.2 and the improvised hyphen

- **3.1 — human-readable notification labels.** The reason code written to the GHL
  `last_escalation_reason` custom field is now translated for the owner: `refund_request` reads
  "Refund request", `sanitizer_empty_output` reads "Bot couldn't answer, jumping to you",
  `llm_failed` reads "Technical issue, bot paused". The full mapping from the QA table is
  implemented, plus labels for the reasons the table did not cover (image_without_url,
  attachment_fetch_failed, implied_handoff_no_tool_call, internal_vocab_leak). An unmapped reason
  degrades to a readable sentence rather than leaking snake_case. The RAW code still goes to
  `escalations.reason` and the `escalated_to_owner` event, so analytics and debugging are unaffected.
  A test asserts no label contains our internal vocabulary. **The notification TEMPLATE itself is
  still Croatian and lives in the GHL workflow — that half is on the owner's side.**
- **3.2 — voice notes misclassified as video.** Root cause found: Instagram voice notes arrive from
  GHL as `.mp4`, identical in the URL to a real video, so our extension heuristic labelled them
  `video_attachment` and the owner was told to go watch a video. *(The first fix attempted here read
  `Content-Type` and did not work — see 4m; the working fix inspects the container.)*
- **4.7 improvised hyphen.** "live availability-just grab a spot" was ours, not the model's: the
  sanitizer rewrote an em dash to a bare hyphen, which glued the words either side together and
  read as exactly the improvised dash the style rules ban. Em and en dashes now become a comma with
  the surrounding spaces absorbed, so it reads "live availability, just grab a spot".

Still open and needing a product decision: **4.6 (one turn, one message)**. The two-bubble replies
are our sanitizer splitting at `max_words_per_message`, currently 40. Options are to raise the cap
(~60, so splitting becomes rare), to disable splitting entirely, or to keep it as is.

## 4m. Retest findings — one of them worse than what was reported

Re-running your Section 3 and 4 tests against the deployed fixes produced two failures and, in the
same transcript, a third problem nobody had reported.

**Confirmed working first:** item 4.1 is genuinely fixed. Three escalations in one session produced
three *different* lines written by the model — "oh no, let me get renata on this for you right away"
(refund), "that's one for renata herself, let me get her on this for you" (health), "sure thing, i'll
get renata to handle this for you" (owner request). Previously all three shipped the identical
hardcoded sentence.

### The serious one: a promised handoff with no escalation

A client asked to speak to the owner. The bot replied *"sure thing! i'll get renata to handle this for
you 🤍"* and **no escalation fired at all** — the client was promised a human and the owner was never
told. This is the June failure mode returning through a new door, and both causes were ours:

1. The handoff-promise detector knew the "let NAME handle this" family but not "get/ask/have NAME **to**
   handle this".
2. **Our own item 4.8 caused the rest.** Locking the reply voice to all-lowercase made the model write
   "i'll" and "renata", while the detector's name patterns required `[A-Z][a-z]+` and a capital I.
   Several patterns went silent the moment the style rule shipped.

The second cause is the one worth remembering: **a prose change in the prompt disarmed a safety net in
the backend**, and it only surfaced when a real client went unescalated. The fix stops guessing at
names — the detector now matches the salon's actual `owner_first_name` from the SOT, spelled
case-insensitively so the rest of each pattern can stay case-sensitive. Straight and typographic
apostrophes are both accepted. The "one for NAME" pattern deliberately refuses a pronoun, because
"this is for her" is ordinary product talk and a false positive costs a needless four-hour pause.

### Voice notes: the first fix could not have worked

`Content-Type` does not distinguish them. GHL serves a voice note and a video **both** as
`video/mp4` — verified directly against the production assets. The container does distinguish them:

| | Video | Voice note |
|---|---|---|
| ftyp brands | `isom iso2 **avc1** mp41` | `isom iso2 mp41` |
| Track handler | `vide` | `soun` |
| Size | 619 KB | 12.7 KB |

`avc1` is an H.264 codec brand. The probe now reads the first 4 KB with a Range request and
classifies on that, falling back to the ftyp brand list when `moov` sits out of range. Any failure
still keeps the inferred type.

### Health question: escalates correctly, categorised generically

The health question produced a warm contextual line and a real escalation, but under
`implied_handoff_no_tool_call` rather than `medical_question`, because the model wrote the handoff
language without firing the tool and the safety net caught it. Functionally right, semantically
vague. This is chronic gpt-4o tool-call unreliability and is the strongest argument for the structural
change we are considering separately: returning the reply and its intent as one structured object, so
they cannot diverge.

## 4n. Three defects in the reply splitter — including dead booking links

Item 4.6 arrived as a style note ("one turn, one message"). Reading the splitter against stored
production output showed the style point was the least of it. All three defects below were live, and
all 419 tests were green throughout, because no test sent a long reply that also contained a link.

**Dead booking links.** The splitter finds sentence boundaries with `/[^.!?]+[.!?]+/` and rejoins the
pieces with a space. A domain is full of dots, so it read
`lumenhairstudio.glossgenius.com/book` as three sentences and shipped
`lumenhairstudio. glossgenius. com/book` — a link the client cannot click. **Confirmed twice on
2026-07-15.** The sanitizer already masked URLs behind placeholders for the character scrub, but
restored them *before* the split; they now stay masked through it.

**Silently discarded text.** A trailing `.slice(0, maxMessages)` threw away everything past the bubble
cap. A 104-word reply on 2026-07-21 lost roughly 24 words — and anything sitting at the end, the
booking link included, went with them. The final bubble now absorbs the remainder.

**Mid-sentence truncation.** A single sentence longer than the word cap was cut with
`slice(0, maxWords)` and its tail dropped. An oversized sentence now goes out whole; one long bubble
beats half an answer.

The word cap and bubble count are unchanged (40 words, 2 bubbles) — that part of 4.6 is a product
decision and is still open. What is fixed is the damage.

**Worth flagging for your own testing:** if you saw a reply where the booking link looked odd or a
message seemed to stop mid-thought, this was why, and it was not the model.

## 5. Bonus finding for the GHL side

The client's text bubble **"Do you do this type of hair?"** (sent alongside a shared IG post,
Jul 6 ~18:52 UTC) **never reached the backend** — the DB has only an image event with no text.
The GHL workflow did not deliver the text accompanying the shared post. Worth checking the
workflow trigger/merge tags for shared-post messages; the backend has nothing to fix until the
webhook arrives.

## 6. GHL-side blockers B1 / B2 — resolved (owner's side)

- **B1 (owner notifications on escalation)** — resolved. The escalation path already flips the
  `escalation_active` tag, sets `last_escalation_reason`, and sets `handoff_until`; the owner
  notification is a GHL workflow keyed on that tag, now wired up and working.
- **B2 (resume when the owner is done)** — resolved. A GHL workflow now fires on the
  `escalation_active` tag being removed and calls the backend `/webhooks/ghl/resume` endpoint,
  which clears `handoff_until` so the bot resumes. Confirmed working.

Both were GHL-workflow configuration, not backend code.

## 7. What is still open before Round 2.5

Everything in Round 2 that is backend work is done and deployed. Five things remain, and none of them
are code we are still writing.

**Waiting on the owner (GHL configuration)**

1. **3.1, second half — the notification template is still Croatian.** The reason code inside it is
   now a human English label, but the surrounding template ("treba tvoju pažnju", "Ukloni tag...")
   lives in the GHL workflow and has to be rewritten there, and made per-install.
2. **3.5 — notification targeting.** Only the owner user receives the push. That is the intended
   shape, but it needs documenting where it is set so it is repeatable for the next salon.
3. **3.4 — assigning the conversation.** Ready to implement as soon as we have the owner's GHL user
   ID; the escalation currently tags the contact but leaves the conversation unassigned.

**Decisions**

4. **3.3 — the auto-resume window.** Auto-resume works (there are `auto_timeout` events in
   production), but the window is **4 hours** and you suggested **12**, pending your sign-off. One
   edge we found while checking: if `removeTag` fails during auto-resume the escalation is already
   marked resolved, so the tag can be orphaned in GHL while the database believes it is closed.
5. **4.6 — one turn, one message.** The three defects behind it are fixed (4n). What remains is the
   knob: 40 words, at most 2 bubbles. Nothing currently argues those numbers are wrong, so they stay
   until the retest gives a reason to move them.

**Verification, not fixes**

Item 4.9 (the real-person polarity fix) and all of Section 6 need a run. Two items from our own
retest also need re-checking after the latest deploy: a voice note should now escalate as
"Client sent a voice note, take a look", and "I would like to speak to renata" must produce an
escalation, not just a warm sentence.
