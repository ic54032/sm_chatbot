# Backend-side report — July incident + answers to the [CONFIRM] items

To: Lovre
From: backend (Ivan)
Date: July 2026 (updated through July 16)

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

Fix (backend): a new branch in the empty-output handler — if the client's last message is a clear
ready-to-book signal, send the booking link (reusing the existing mark_link_sent fallback: paste
booking.url, or the point-back nudge if sent recently) instead of retrying/escalating. The signal is
`containsBookingIntent` (new src/core/detect-booking-intent.ts): ANCHORED phrases only ("book me in",
"i want to book", "ready to book", "sign me up", ...), never bare "ready"/"let's do it", with a
leading-negation and trailing-deferral veto ("don't book me in", "book me in another time"). It reads
ONLY the client's message, never a tool call, so it can never send a link merely because some
unrelated tool fired on a non-booking turn.

Design + implementation were adversarially reviewed (a false-positive-surface workflow + a wiring
review). Two findings shaped the final design: (1) a tool-based signal (fire on set_state_flag
clearing the hesitant flag) was DROPPED because it trusts the model's flag inference on the very turn
it malfunctioned, and adds the exact stray-link risk without adding real coverage; (2) the negation
veto was anchored to the token immediately before the phrase so an enthusiastic "I can't wait, book me
in!" is not wrongly missed. Non-booking empty output still retries-then-escalates (preserving the B5
hard-message handoff). This is backend-only; no prompt or Layer 1 change needed for B4.

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
