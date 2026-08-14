# Repo cleanup and critical code review — design

**Date**: 2026-07-26
**Owner**: Ivan
**Status**: awaiting review (not yet committed)

---

## 0. Context

The codebase grew fast under delivery pressure and two QA rounds. It works, and it is small — 58
source files, 4522 LOC — but it carries leftovers that are invisible from the outside:

- `src/core/canned-messages.ts` exports `sendCannedReassurance`, which has **four tests and zero
  production callers**. The suite is green, coverage looks fine, and the code never runs. This is the
  most dangerous shape of dead code because it actively misleads.
- `src/core/generate-response.ts` is **672 LOC**, 3.4× the next largest file (199), and holds roughly
  ten responsibilities in one function.
- There is **more test code than production code** (5523 vs 4522 LOC), so test bloat is a real
  maintenance cost of its own.
- A mock-GHL subsystem (`ghl/mock.ts`, `routes/dev-simulate.ts`, and two database tables) sits in
  production code and the production schema. Both tables hold **0 rows in production**.

### Goals

1. Remove code that is not reachable in production, with evidence rather than intuition.
2. Critically evaluate the code that IS reachable, and improve it where improvement is justified.

### Non-goals

- Adding features or changing product behaviour for its own sake.
- Rewriting the master prompt (that is Lovre's Layer 1 and has its own process).
- Performance work. Nothing in the current profile suggests it is needed.

---

## 1. Constraints

**Approval workflow.** For every finding: explain it, propose a fix, wait for approval, then apply.
Nothing changes because it looked wrong to me.

**Sequencing.** All of this starts **after QA Round 2.5 passes**. Freezing behaviour until then means
that any test failure during the refactor unambiguously says "I broke something" rather than "the
colleague's finding and my change are tangled".

**Branch.** Work happens on `chore/repo-cleanup`, merged after each pass, so there is always a known
green state to return to.

---

## 2. Prerequisite: a working end-to-end safety net

E2E tests currently cannot run locally — there is no Postgres listening, so the migrator fails before
any test executes. Throughout the QA work this was acceptable; for a refactor it is not. Unit tests
mock every repository, so they cannot catch the errors a refactor actually causes: a changed call
order, a lost transaction, a repo contract that shifted under its caller. The 8 e2e tests cover
idempotency, auto-resume, image handling and the empty-output ladder — precisely the paths this work
touches.

**Action:** stand up a local Postgres in Docker, point `TEST_DATABASE_URL` at it, and confirm
**415 unit + 8 e2e green**. That number is the baseline every later commit must still meet.

**Related hardening, in scope.** `tests/helpers/test-db.ts` truncates seven tables in a `beforeEach`:

```sql
TRUNCATE TABLE mock_contact_state, mock_outbound_log, escalations,
  conversation_events, messages, conversations, salons
RESTART IDENTITY CASCADE
```

`TEST_DATABASE_URL` defaults to localhost but nothing stops it being pointed at production, which
would wipe every salon, conversation and message before each test. Add a guard that refuses to run
when the URL does not look like a test database.

---

## 3. Pass 1 — mechanical dead-code detection

### Tooling

- **knip** — module-graph analysis for unused files, exports, types and npm dependencies.
- **vitest --coverage** — per-file and per-line coverage.

`depcheck` is redundant (knip covers dependencies) and `madge` is only worth adding if we see
symptoms of circular imports.

**Entry points must be declared explicitly** or knip reports half the application as unused. For this
repo they are: `src/index.ts` (server), `src/db/migrate.ts` (CLI — the reason it appears unimported),
`scripts/*`, and `tests/**`.

### Classification

Crossing "reachable from `index.ts`" with "covered by tests" gives four buckets:

| # | Reachable | Covered | Meaning | Action |
|---|---|---|---|---|
| 1 | no | no | plain dead code | delete |
| 2 | **no** | **yes** | **zombie** — green tests, code never runs | delete the code **and its tests** |
| 3 | yes | no | cold path | judgement: dead branch, or a real path with no test? |
| 4 | no (from src) | yes | genuine test helper | keep |

Bucket 2 is the highest-value category and the reason tooling beats reading: `sendCannedReassurance`
is invisible to a human walking the execution flow, because a dead function is by definition not on
it.

Bucket 3 is **not** a deletion list. `src/llm/gemini.ts` (73 LOC) is reachable through
`salon.config.llm_model`, but if no salon selects Gemini it never executes. Deleting it and dropping a
supported provider are different decisions, and that one is the owner's.

### Deliverable

A single findings table — symbol or file, bucket, evidence, proposed action. Approval per bucket or
per row. Deletions land as one commit per bucket, with build and the full suite green after each.

### Known candidates

From a preliminary grep, to be confirmed by knip (the grep is a preview, not proof — several of the
15 "unused" exports are almost certainly composed into `allTools` and similar):

- `core/canned-messages.ts` and its four tests — bucket 2.
- `StubLlmClient` — bucket 1.
- `WebhookSecretMismatchError`, `SalonNotFoundError`, `runHealthCheck` — need verification.

### Decided: isolate the mock-GHL subsystem

`ghl/mock.ts` (98 LOC), `routes/dev-simulate.ts` (63 LOC) and the `mock_outbound_log` /
`mock_contact_state` tables are development scaffolding living in production code and the production
schema. The dev route is correctly gated (`if (nodeEnv === 'production') return;`), so this is not a
security exposure, and both tables are empty in production.

**Decision: isolate rather than delete** — the mock stays available to tests, but leaves the
production surface entirely. This is cheap because `tests/helpers/test-app.ts` already constructs
`MockGhlClient` directly and builds its own one-line factory; it never goes through
`makeGhlFactory({ useMock })`. Concretely:

1. Move `src/ghl/mock.ts` into `tests/helpers/`. Its only remaining source consumer is the `useMock`
   branch in `ghl/factory.ts`, which production never takes.
2. Delete that branch and the `useMockGhl` config flag with it, so the factory has one job: build a
   real client.
3. Remove the `dev-simulate` route. It is already inert in production by its own guard, and its
   `stage_get_message` feature depends on the mock we are moving out. Local simulation is covered by
   the e2e test app. **Reversible** — if it turns out to be part of a workflow, it comes back as a
   test-side utility rather than a registered production route.
4. Move `mock_outbound_log` and `mock_contact_state` out of the production migration into a test-only
   migration applied by `test-db.ts`. E2E tests assert on `mock_outbound_log`, so the tables must
   still exist for the test database; splitting the migration is what makes the isolation real rather
   than cosmetic. The production tables are dropped in a follow-up migration, safe because both hold
   zero rows.

### Decided: delete the unused LLM providers

`src/llm/anthropic.ts` and `src/llm/gemini.ts` (~146 LOC together) are selected by the `LLM_PROVIDER`
environment variable, which **defaults to `gemini`** while production runs OpenAI. Neither has ever
executed against a real API.

The argument for keeping them is insurance: "provider outage or retired model" was one of the three
candidate causes considered during the July 21 outage. That argument does not survive contact with
the detail — **an unexercised provider is not insurance**. Anthropic's multimodal content-block
mapping has never run once; the first time it did would be during an incident, which is the worst
possible moment to discover it is wrong. Meanwhile the `LlmClient` interface stays, so re-adding a
provider later is a contained, well-understood job of roughly 70 lines.

**Decision: delete both**, along with the provider enum and the two unused API-key fields in
`config.ts`, leaving the factory with one job: build the client we actually use.

---

## 4. Pass 2 — flow-walk critical review

Six batches following an inbound message end to end. Each batch produces findings with proposals,
gets approved, is applied, and is committed with the suite green.

| # | Batch | Files |
|---|---|---|
| 1 | Ingress and intake | `webhooks-ghl-inbound`, `config`, `handle-inbound` (199), `parse-webhook-attachments`, `refine-media-type` |
| 2 | Queue and worker | `queue/index`, `workers/respond` (136) — coalescing, locking, drain |
| 3 | Generation | `core/generate-response.ts` (672), on its own — see section 10 |
| 4 | Prompt and LLM | `prompt/build`, `load-master-prompt`, `media-marker`, `tools`, `llm/*` — see section 10 |
| 5 | Output | `sanitizer/*`, `extract-leaked-tool-calls` (148), `detect-*` |
| 6 | Delivery, persistence, background | `ghl/real`, `escalate`, `db/repos/*`, `auto-resume`, `health-check`, admin routes |

### Evaluation criteria

1. **Correctness and risk** — silent failure paths, unhandled errors, races. Checked against real
   production rows, not only by reading (see section 9 for why this is not optional).
2. **Single responsibility and size.**
3. **Duplication.**
4. **Boundaries** — can the internals change without breaking consumers?
5. **Naming and comments.** This repo's comments are unusually good: they explain *why*, often citing
   the production incident that motivated the code. They are preserved, and moved with the code they
   explain.
6. **Test value** — does the test prove anything, or does it restate the implementation?
7. **Consistent error handling.**

### The rule that keeps this safe

**Untested code is not refactored.** Where pass-1 coverage shows the code being restructured has no
test, a characterization test pinning current behaviour is written **first**. A refactor without a net
is a rewrite with extra steps.

### Where `generate-response.ts` is likely to go

A sketch to make the direction concrete, not a commitment — the review refines it:

```
loadTurnContext      context load, handoff and answered guards
prepareImages        fetch, process, degrade
runGeneration        LLM call and retry policy
recoverIntent        native plus leaked tool calls
recoverEmptyOutput   corrective retry, then escalation / link / booking ladder
deliver              send loop, persistence, events
```

An orchestrator that reads like the flow. The goal is not fewer lines but pieces that each fit in your
head at once.

---

## 5. Pass 3 — documentation

Lowest risk, done last. `docs/` holds 13 markdown files, including superpowers plans and specs from
May that describe a system that has since changed.

Each file is sorted into one of two piles. **Historical** documents move to `docs/archive/` unchanged,
with a one-line header stating the date they stopped describing reality — they are a record of why
decisions were made and are not edited to match the present. **Living** documents stay where they are
and must not contradict each other; the report for Lovre and the retest script are the two that are
actively read, so where an archived plan disagrees with them, the archived one is the one that moves.

---

## 6. Verification

- Every commit: `npm run build`, full unit suite, full e2e suite — all green.
- Baseline to preserve: **415 unit + 8 e2e**. The count may rise as characterization tests are added;
  it may not fall except where a test is deleted alongside the dead code it covered, and each such
  deletion is called out explicitly.
- Deletions are verified by absence of references, not by "tests still pass" alone — a zombie's tests
  pass precisely because the code is unreachable.

---

## 7. Risks

| Risk | Mitigation |
|---|---|
| A "pure" refactor changes behaviour | E2E net restored first; characterization tests before restructuring untested code |
| Deleting something that is reachable in a way the tool cannot see (dynamic import, config-selected provider) | Bucket 3 is judgement, not automatic deletion; provider modules are an explicit product decision |
| Approval fatigue across many findings | Findings are batched (one table per bucket, one per flow batch), not delivered one at a time |
| Refactor collides with QA fixes | Work starts only after Round 2.5 passes; on a branch, merged per pass |

---

## 8. Open questions

None blocking. Both questions this design opened with have since been answered:

1. ~~Whether to keep the Gemini and Anthropic providers~~ — **decided: delete** (section 3).
2. ~~Whether message splitting stays at 40 words~~ — the question turned out to be hiding three
   defects rather than a preference, and those are fixed (section 9). What remains is only the
   cosmetic knob: 40 words and at most 2 bubbles. No evidence currently says either number is wrong,
   so it stays until the retest gives a reason to move it.

---

## 9. Fixed during design: the splitter was damaging output

Writing this design surfaced three defects worth recording, because they justify a technique the
review should use deliberately.

Item 4.6 arrived as a style note — "one turn, one message". Reading the splitter against real
production output showed the style point was the least of it:

- **Dead booking links.** The splitter reads sentence boundaries with `/[^.!?]+[.!?]+/` and rejoins
  the pieces with a space. A domain is full of dots, so `lumenhairstudio.glossgenius.com/book` was
  shipped to clients as `lumenhairstudio. glossgenius. com/book`. Confirmed twice on 2026-07-15.
- **Silently discarded text.** A trailing `.slice(0, maxMessages)` threw away everything past the
  bubble cap. A 104-word reply on 2026-07-21 lost roughly 24 words, and anything at the end went
  with them.
- **Mid-sentence truncation.** A sentence longer than the word cap was cut and its tail dropped.

Fixed in `f389a78`: URLs stay masked through the split, the final bubble absorbs the remainder, and an
oversized sentence goes out whole.

**The lesson for pass 2.** All 419 tests were green, because no test sent a long reply that also
contained a link. The bugs were only visible by reading stored production output next to the code
that produced it. So the flow-walk is not a pure reading exercise: at each batch, sample real rows
from `messages` — `ai_raw_output` beside `text_content`, and `sanitize_mods` — and ask whether the
code did to that input what it was supposed to. A test suite proves the cases someone thought of; the
production table shows the ones nobody did.

---

## 10. Considered: regex semantics, LLM classification, or neither

Three of our detectors judge meaning with regular expressions, and all three failed in production
during the design of this document:

- `detect-handoff-promise` missed "i'll get renata to handle this for you" and **no escalation fired
  at all** — the client was promised a human and the owner was never told.
- `detect-booking-intent` cannot cover paraphrase ("count me in", "yeah go for it") by construction.
- `internal-vocab` needed two adversarial rounds to settle both false positives and false negatives.

The most damning of these is indirect: **the all-lowercase style rule (QA item 4.8) silently
disarmed the handoff detector.** A change in one layer's prose broke a safety net in another, and it
only surfaced when a client went unescalated. Regex semantics are coupled to surface form in ways that
are invisible until they fail.

So the instinct — hand semantic judgement to the model — is sound. It just is not the best fix for
the case that matters most.

### The objection to LLM classification

These detectors exist **because the model is unreliable**. `detect-handoff-promise` is the net for
"the model wrote a handoff promise but did not fire `escalate_to_owner`" — a tool it had available
and was explicitly instructed to fire. Asking that same model a second question is using the
unreliable component to check itself.

The objection is not fatal: a narrow classification in a clean context is empirically far more
reliable than tool-call compliance inside a 13k-token prompt. But it is the same source of
nondeterminism, and it costs something real — 58 tests currently pin the handoff detector's behaviour
exactly. With a classifier, regression testing becomes statistical: eval sets and accepted
distributions rather than assertions.

### The better answer for the main case

**None of our three tools returns data.** `mark_link_sent`, `set_state_flag` and `escalate_to_owner`
only record a side effect alongside the reply; there is no second model call carrying tool results.
The generation is single-shot with annotations, which means tool-calling was arguably the wrong
mechanism from the start. The natural shape is a structured output:

```json
{
  "reply": "that's one for renata herself, let me get her on this 🤍",
  "escalate": { "reason": "medical_question" },
  "link_sent": false
}
```

With a strict JSON schema the failure mode "wrote the promise, forgot the tool" **cannot occur** —
text and intent arrive in the same object and cannot diverge. No detector, no second call, no added
latency, no pattern maintenance. It also fixes the loss we saw on 2026-07-26, where a health question
escalated under the generic `implied_handoff_no_tool_call` because the tool never fired: with `reason`
as a required field, the semantic reason cannot go missing.

### Per-detector decision

| Detector | Decision | Reason |
|---|---|---|
| `detect-handoff-promise` | **Remove** via structured output | Makes the failure impossible rather than caught |
| `detect-booking-intent` | **Keep the regex** | Now only a last-resort net on double-empty output; its brittleness no longer costs anything |
| `internal-vocab` (1.9) | **Keep the denylist** | The problem really is lexical — "did the word *escalating* appear" — and determinism is worth keeping |
| `extract-leaked-tool-calls` | **Keep** | Syntax parsing, not semantics. Regex is the right tool |

The framing "regex or LLM" is a false choice. One case wants a structural change; the others want
regex, for different reasons.

### Cost and timing

Moving to structured output touches the `LlmClient` interface, every provider, the response-handling
path in `generate-response.ts`, and a slice of the tests. It is **not** a pre-Round-2.5 change. It
belongs to pass 2, batches 3 and 4, and is probably the largest single reliability gain left in this
codebase — the leaked-tool-call parser, the handoff-promise net, and the empty-output intent-carrying
logic all exist to compensate for a mechanism we do not actually need.
