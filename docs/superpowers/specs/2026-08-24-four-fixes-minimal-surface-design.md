# Four fixes, minimal surface

**Date:** 2026-08-24
**Status:** approved, ready for an implementation plan
**Evidence base:** production window 2026-08-23 17:23 UTC to 2026-08-24 07:12 UTC, build `a25b239`, ~30 client turns across four pod restarts

---

## 1. Why these four, and why now

The 24-test retest ran against a confirmed-live build. Twenty checks ran: three were not
exercised and one is permanently N/A. Sixteen passed cleanly, two were partial, two failed,
and every check that had been fixed by stating a deterministic fact in the conversation
state block passed on its first outing.

Four things need fixing. Three come from that retest and the fourth from a field report the
script did not cover:

1. A tool call with no reply text forced a corrective retry, the retry broke the 30,000 TPM
   ceiling, and on one turn the client asked for the booking link and did not get it.
2. Three client messages arrived in one burst, all three reached the model in a single
   request, and the middle question went unanswered.
3. The bot admitted a limitation on video and voice ("can't view videos directly"), which
   two separate prompt rules forbid in plain words.
4. On a Sunday the bot said the salon opens "tomorrow from 10am to 7pm". The source of
   truth says Monday is closed and 10am to 7pm is Tuesday's hours.

The design principle running through all four: **the model is doing an inference it should
never have been asked to make.** Either hand it the answer as a fact, or remove the thing
that prompted the wrong answer. Two of the four fixes remove code rather than add it, and
the other two add a handful of lines each to a state block that already exists.

### What the evidence says about levers

Four mechanisms have now been tried on this prompt, and the session gives a clean read on
each:

| Lever | Result |
| --- | --- |
| Deterministic fact in the state block | Works. `visiblePhotos` and `answeredPhotos` both passed live on their first outing. |
| Deterministic sanitizer pass | Works. The banned-opener strip fired twice in production, visible as the gap between `textPreview` and the sent message. |
| Worked example, error is structural | Works. The consult-objection pair fixed a failure that prose alone had not. |
| Negative prose rule | Fails. Five instances this week, most recently a rule that says "not even softened with 'but'" sitting two lines above a demonstration of exactly that. |

This is why nothing below is a new prose rule.

---

## 2. Fix 1 — delete `mark_link_sent`

### The failure

Six turns produced a tool call with no reply text: `escalate_to_owner` three times,
`set_state_flag` once, `mark_link_sent` once, and `mark_link_sent` plus `set_state_flag`
once. Each one triggers the corrective retry, and the retry arithmetic is deterministic:
the main call is roughly 16,500 tokens, the retry roughly 15,400, and the ceiling is
30,000 per minute. **The retry cannot fit.** Eight 429s followed.

Seven recovered after the wait and cost seconds. One did not. At 18:33 the client sent
"Could you send it again", the model fired `mark_link_sent` with no text, three 429s
exhausted the retries, and `recoverWithoutText` shipped a canned line that does not
contain the URL:

> the booking link I sent has all the latest openings 🤍

The client had explicitly asked for the link and did not receive it.

### The fix

`mark_link_sent` is already redundant. `generate-response.ts` records the dedup event as:

```ts
const containsLink = sanitized.messages.some((m) => m.includes(salon.sourceOfTruth.booking.url));
if (linkSentToolCalled || containsLink) { /* record booking_link_sent */ }
```

The `||` means deriving the fact from the sent text is sufficient on its own. Remove the
tool definition and the `linkSentToolCalled` branches that carry it.

This is the only fix in the set that **reduces** the codebase, and it is also strictly more
reliable than what it replaces: today, a model that pastes the link but forgets the tool
leaves the dedup window unopened, and the bot re-pastes the URL on the next turn.

Keep `containsBookingIntent(lastInbound?.textContent)`. That is a check on the **client's**
message ("book me in") and has nothing to do with the tool.

Keep `set_state_flag`. Deriving `last_quoted_service` would mean parsing which service the
bot named in its own prose, which is the regex-over-semantics approach this project has
already rejected on principle.

### What this does not fix

Three of the six empty outputs were `escalate_to_owner`, and those retries will still trip
the ceiling. They cost about five seconds and they recover. They are also earning their
keep: the three retries in this window produced three *different* warm handoff lines, which
is exactly the behaviour the corrective retry was built to protect after 17% of one day's
replies came out canned. Raising the OpenAI tier would remove the latency, and was
considered and declined: it hides the symptom, costs money monthly, and fixes no bug.

---

## 3. Fix 2 — state how many messages are waiting

### The failure

At 18:24 the client sent three messages five seconds apart: how long balayage takes,
whether the salon takes card, and what parking is like. `messageShapes` shows all three in
the same request at idx 12, 13 and 14. The reply answered balayage and parking and said
nothing about payment.

This settles the mechanism. Coalescing is correct, the drain is correct, all three messages
reach the model, and the model drops the middle one. Nothing in the prompt tells it that a
trailing run of client messages is one burst in which every question needs an answer.

### The fix

`buildPrompt` already walks backwards from the newest message to the last outbound in order
to count `visiblePhotos`. The same loop counts messages. Emit one more state line:

```
- Client messages waiting for this reply: 3
```

Plus one rule reading it: when the number is above 1, these arrived as one burst and every
question in them needs answering, not just the first and the last.

Two lines of code, reusing a loop that already exists, feeding a mechanism that has now
worked four times.

---

## 4. Fix 3 — remove the trigger and the sentence

### The failure

Two prompt rules forbid this in plain words: "never say what you can or cannot open" and
"Do not ADMIT a limitation". A third says "not even softened with 'but'". Production:

> can't view videos directly, **but** tell me what you're going for, and i'll lend a hand! 🤍

### Finding A: the marker is the trigger

The same session, the same build and the same prompt produced three different outcomes,
and the only variable was whether a marker named a medium:

| Path | Marker | Outcome |
| --- | --- | --- |
| Reel pasted as a link | none, arrives as a text URL | Clean twice. "ooh, what do you love about that one?" |
| Voice note | `[client sent a voice note]` | Softened twice. "i'm set up just for text" |
| Video | `[client sent a video]` | Failed. "can't view videos directly" |

Where the marker names a medium the model knows it cannot consume, it discloses. This is not
disobedience; it is a well-aligned assistant being honest about a limitation it has just
been told about. Where nothing names a medium, there is nothing to disclose.

### Finding B: the BAD example is teaching the failure

The prompt already carries a worked pair for this exact case:

```
BAD, admits the limitation before redirecting:
You: "I didn't receive a video, but feel free to describe what you're looking for!"
```

Production output is a paraphrase of that line, down to the `but`. Compare the pair that
**did** work, on the consult objection:

```
Bad:  "let me get [owner] to handle this for you 🤍"
You:  reframe warmly, the consult is short… No tool call this turn
```

There the sentence is fine and the error is the *timing*, and the GOOD side is a description
of behaviour with nothing quotable in it. Here the error **is** the sentence, and the
sentence is fluent, warm and plausible.

> **A BAD example is safe when the error is structural and the GOOD side is written as
> behaviour. It is dangerous when the BAD side is a fluent sentence in the bot's own voice,
> because the model copies fluent sentences regardless of the label.**

This explains three separate incidents in this repository: the flagship photo example that
demonstrated the generic opener it was meant to forbid, the stylist roster sentence that
shipped verbatim to two clients, and this one.

### The fix, three subtractive moves

1. **Delete the BAD sentence.** Stop showing the model the construction.
2. **Rewrite the GOOD side as behaviour, not a quotable line**, mirroring what made the
   consult-objection pair work. The current GOOD line is also a copyable sentence, and
   shipping any sentence twice is separately forbidden.
3. **Rewrite the markers so none of them names a medium.** Video, voice note and unviewable
   media all lead to the same action, so four markers collapse to two:

```
[client sent a video]                                  ┐
[client sent a voice note]                             ├─→ [no text in this message, ask
[client sent an attachment that did not come through]  ┘     what they are after]

[photo not received]                                   ──→ [no image in this message, invite
                                                             them to send it again]
```

These two strings are the wording to implement, not a sketch. They name no medium and no
capability, and each is true whatever arrived.

Note the comma rather than a dash. The marker text is rendered into the user turn the model
reads, and the prompt's punctuation rule bans em dashes in replies, so seeding one into the
context invites the model to echo it back.

`mediaMarkerFor` is called only from `build.ts` to render the prompt. The owner-facing
notification picks `video_attachment` or `audio_attachment` separately, so collapsing the
markers changes nothing the owner sees.

### Rejected alternative: excise the admission in the sanitizer

Five production samples all have the shape `<admission>, but <good content>`, and cutting up
to and including `, but ` leaves a valid warm message every time. It was rejected anyway: it
treats the symptom after generation, it mangles text whenever the shape does not match, and
the same judgement was already made and recorded for the vocabulary tripwire, which
regenerates rather than excises for exactly this reason.

### Pre-agreed escalation

If video or voice admit a limitation again after this, the prompt contains neither the
trigger nor the sentence to copy, and deterministic detection becomes the only remaining
option. That is the boundary condition, agreed in advance so the next round is not a debate.

---

## 5. Fix 4 — state today's and tomorrow's hours

### The failure

On Sunday at 11:24 Denver time the bot said "not today, but we'll be open tomorrow from 10am
to 7pm". The source of truth says `monday: "closed"` and `tuesday: "10am to 7pm"`. The bot
took Tuesday's hours and attached them to Monday.

The time half is now right, which is a change from the Round 3 finding: that report had the
day logic correct and the clock wrong. This is the mirror image.

### The fix

The first instinct was to compute "the next open day", which needs a parser for strings like
`"10am to 7pm"`. That is unnecessary. Two direct lookups from `operating_hours` are enough:

```
- Today (Sunday) hours: closed
- Tomorrow (Monday) hours: closed
```

No arithmetic and no parsing. The model cannot claim Monday is open when the state block says
it is closed, and "are you open right now" reduces to comparing the injected clock against
one short string rather than reasoning across a week.

Roughly six lines, using the salon timezone already resolved for the existing datetime line.

---

## 6. Testing

Unit tests, added alongside each fix:

- **Fix 1.** The dedup event is recorded when the sent text contains the booking URL and no
  tool was called. A turn that neither sends the link nor calls the tool records nothing.
- **Fix 2.** The waiting count is the length of the trailing inbound run: 1 for a single
  message, 3 for a burst of three, and it resets to 1 after an outbound. An owner message
  ends the burst exactly as an outbound one does.
- **Fix 3.** The admission family appears **nowhere** in the prompt, BAD lines included.
  This is the inverse of the existing guard that allows a generic photo opener only on a
  `Bad:` line, and it is the thing that stops a fourth recurrence. Plus: `mediaMarkerFor`
  returns the ask-what-they-are-after marker for video, audio and unviewable media, and the
  resend marker for a failed image.
- **Fix 4.** Today and tomorrow are read from `operating_hours` by weekday name in the salon
  timezone, including the Sunday-to-Monday wrap.

Manual verification is the existing retest script, with the failing rows re-run: A4, B1, B2,
B5, B6, and the three-message burst that is not yet in it.

---

## 7. Out of scope

- **Structured output replacing tool calling.** It would fix Fix 1 at the root by making
  reply text part of the schema rather than something the model may omit. It touches roughly
  fifteen branches that read `toolCalls`, so it is a separate piece of work.
- **Shortening the master prompt and minifying the source-of-truth JSON.** The real token
  lever: the prompt is 53KB and the SOT is pretty-printed. It would give the retry room
  inside the ceiling. Layer 1 belongs to a colleague, so it needs coordination.
- **Images re-downloaded and recompressed on every turn.** One image was processed five
  times in a single window, roughly 1.3 seconds each, including on turns with nothing to do
  with photos. Real, and unrelated to these four.
- **An image that arrives and is declared broken.** At 17:49 a photo reached the model
  (`imageCount: 1`) and the reply was "looks like something went wrong with that image". The
  image was 720x1280 compressed to a ratio of 0.24, and a later one was 167x298. The
  suspicion is that compression or source size degrades the image below usability. That is a
  hypothesis and needs its own investigation.
- **GHL intermittently losing media sent with a caption.** Reproduced twice, now logged well
  enough to attribute next time.
