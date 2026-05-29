# Fillchair Prompt + Lumen Salon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Zamijeniti hardkodirani system prompt novim file-based promptom, prijeći na novu SOT strukturu, i zamijeniti test salon Bella → Lumen (reuse iste GHL lokacije, clean conversation slate).

**Architecture:** Prompt se učitava iz `src/prompt/master-prompt.md` (static, cache-iran), `buildPrompt` slaže: booking-URL header (hybrid verbatim) + master prompt + conversation state + knowledge base (SOT JSON). Nova `SotSchema` validira kritična polja strogo (`salon_basics.owner_first_name`, `salon_basics.salon_name`, `booking.url`, `price_quoting_policy`) i ostalo passthrough. Code-paths koji čitaju SOT prelaze na nove putanje. Data migracija in-place update-a postojeći salon red.

**Tech Stack:** TypeScript + Fastify + Kysely + Postgres + vitest + Zod + pg

**Predecessor spec:** [`docs/superpowers/specs/2026-05-29-fillchair-prompt-and-lumen-salon-design.md`](../specs/2026-05-29-fillchair-prompt-and-lumen-salon-design.md)

---

## Task 1: Master prompt file + loader + build step

**Files:**
- Create: `src/prompt/master-prompt.md`
- Create: `src/prompt/load-master-prompt.ts`
- Create: `scripts/copy-assets.mjs`
- Modify: `package.json` (build script)
- Create: `tests/unit/prompt/load-master-prompt.spec.ts`

This task is independent of the SOT type change — build stays green throughout (nothing consumes the loader yet).

- [ ] **Step 1: Create the master prompt file**

Create `src/prompt/master-prompt.md` with the **full verbatim content** of the user-provided `master_prompt_fillchair.md`, with one correction: every `ð¤` mojibake sequence MUST be replaced with the actual `🤍` emoji (white heart). The source document had an encoding artifact; the file must contain proper UTF-8 🤍.

The content begins with `## IDENTITY AND VOICE` and ends with the `**BAD, admitting you are a bot (never do this):**` example block. Do not alter any wording, section headers, or backtick references (`salon_basics.owner_first_name`, `booking.url`, `escalate_to_owner`, etc.) — they are intentional instructions for the model to read from the knowledge base.

After creating, verify the heart emoji is correct:
```bash
grep -c "🤍" src/prompt/master-prompt.md
```
Expected: a non-zero count (the prompt uses 🤍 in many examples). Expected: `grep -c "ð¤" src/prompt/master-prompt.md` returns 0.

- [ ] **Step 2: Write the failing test for the loader**

Create `tests/unit/prompt/load-master-prompt.spec.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { loadMasterPrompt } from '../../../src/prompt/load-master-prompt.js';

describe('loadMasterPrompt', () => {
  it('returns a non-empty string', () => {
    const prompt = loadMasterPrompt();
    expect(typeof prompt).toBe('string');
    expect(prompt.length).toBeGreaterThan(500);
  });

  it('contains the key sections from the master prompt', () => {
    const prompt = loadMasterPrompt();
    expect(prompt).toContain('IDENTITY AND VOICE');
    expect(prompt).toContain('PHOTO HANDLING');
    expect(prompt).toContain('TOOL USAGE');
    expect(prompt).toContain('PRICE QUOTING');
  });

  it('contains the heart emoji, not the mojibake artifact', () => {
    const prompt = loadMasterPrompt();
    expect(prompt).toContain('🤍');
    expect(prompt).not.toContain('ð¤');
  });

  it('returns the same cached string on repeated calls', () => {
    expect(loadMasterPrompt()).toBe(loadMasterPrompt());
  });
});
```

- [ ] **Step 3: Run test — expect FAIL** (loader module does not exist yet)

Run: `npx vitest run tests/unit/prompt/load-master-prompt.spec.ts`
Expected: `Cannot find module '.../src/prompt/load-master-prompt.js'`.

- [ ] **Step 4: Implement the loader**

Create `src/prompt/load-master-prompt.ts`:
```typescript
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let cached: string | null = null;

/** Loads the static master prompt from master-prompt.md (cached after first read). */
export function loadMasterPrompt(): string {
  if (cached !== null) return cached;
  const here = dirname(fileURLToPath(import.meta.url));
  cached = readFileSync(join(here, 'master-prompt.md'), 'utf-8');
  return cached;
}
```

- [ ] **Step 5: Run test — expect PASS**

Run: `npx vitest run tests/unit/prompt/load-master-prompt.spec.ts`
Expected: 4 tests pass. (Loader reads `src/prompt/master-prompt.md` via `import.meta.url` resolving to the src/ location under vitest/tsx.)

- [ ] **Step 6: Create the build asset-copy script**

Create `scripts/copy-assets.mjs`:
```javascript
// Copies non-TS assets (prompt .md files) into dist/ after tsc, since tsc only
// emits .js. Keeps the runtime loader's relative read (dist/prompt/master-prompt.md)
// working in production.
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const srcDir = 'src/prompt';
const outDir = 'dist/prompt';

mkdirSync(outDir, { recursive: true });
for (const file of readdirSync(srcDir)) {
  if (file.endsWith('.md')) {
    copyFileSync(join(srcDir, file), join(outDir, file));
    console.log(`copied ${file} -> ${outDir}`);
  }
}
```

- [ ] **Step 7: Wire the build script**

Modify `package.json`. Change the `build` script:
```json
"build": "tsc && node scripts/copy-assets.mjs",
```

- [ ] **Step 8: Verify build copies the asset**

Run: `npm run build`
Expected: clean tsc, then `copied master-prompt.md -> dist/prompt`. Verify:
```bash
ls dist/prompt/master-prompt.md
```
Expected: file exists.

- [ ] **Step 9: Commit**

```bash
git add src/prompt/master-prompt.md src/prompt/load-master-prompt.ts scripts/copy-assets.mjs package.json tests/unit/prompt/load-master-prompt.spec.ts
git commit -m "feat(prompt): add file-based master prompt + loader + build asset copy"
```

---

## Task 2: New SOT schema

**Files:**
- Modify: `src/core/sot-schema.ts`
- Create: `tests/unit/core/sot-schema.spec.ts`

⚠️ This task changes the `Sot` type, which introduces a TRANSIENT BUILD BREAK in all consumers (build.ts, generate-response.ts, handle-inbound.ts, salons.ts, and every test fixture that constructs `sourceOfTruth`). Tasks 3-5 resolve these. This mirrors the coordinated-refactor pattern.

- [ ] **Step 1: Write the failing test for the new schema**

Create `tests/unit/core/sot-schema.spec.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { SotSchema } from '../../../src/core/sot-schema.js';

const validSot = {
  salon_basics: {
    owner_first_name: 'Renata',
    salon_name: 'Lumen Hair Studio',
    address: '1847 Pearl Street',
    instagram_handle: '@lumenhairstudio',
  },
  booking: {
    url: 'https://lumenhairstudio.glossgenius.com/book',
    platform: 'GlossGenius',
  },
  price_quoting_policy: 'b',
  service_menu: { color: 'balayage and more' },
  pricing: [{ service_name: 'Full Balayage', price: '$220-$320' }],
  faq: [{ question: 'Do you take walk-ins?', answer: 'By appointment.' }],
};

describe('SotSchema', () => {
  it('accepts a valid new-structure SOT', () => {
    const parsed = SotSchema.parse(validSot);
    expect(parsed.salon_basics.owner_first_name).toBe('Renata');
    expect(parsed.booking.url).toBe('https://lumenhairstudio.glossgenius.com/book');
    expect(parsed.price_quoting_policy).toBe('b');
  });

  it('preserves passthrough fields (service_menu, pricing, faq)', () => {
    const parsed = SotSchema.parse(validSot) as Record<string, unknown>;
    expect(parsed.service_menu).toBeDefined();
    expect(parsed.pricing).toBeDefined();
    expect(parsed.faq).toBeDefined();
  });

  it('preserves passthrough fields inside salon_basics and booking', () => {
    const parsed = SotSchema.parse(validSot);
    const basics = parsed.salon_basics as Record<string, unknown>;
    const booking = parsed.booking as Record<string, unknown>;
    expect(basics.instagram_handle).toBe('@lumenhairstudio');
    expect(booking.platform).toBe('GlossGenius');
  });

  it('rejects missing owner_first_name', () => {
    const bad = { ...validSot, salon_basics: { salon_name: 'X' } };
    expect(() => SotSchema.parse(bad)).toThrow();
  });

  it('rejects invalid booking url', () => {
    const bad = { ...validSot, booking: { url: 'not-a-url' } };
    expect(() => SotSchema.parse(bad)).toThrow();
  });

  it('rejects invalid price_quoting_policy', () => {
    const bad = { ...validSot, price_quoting_policy: 'x' };
    expect(() => SotSchema.parse(bad)).toThrow();
  });
});
```

- [ ] **Step 2: Run test — expect FAIL** (old schema has `.salon`, not `.salon_basics`)

Run: `npx vitest run tests/unit/core/sot-schema.spec.ts`
Expected: failures — `salon_basics` not recognized / parse throws on valid SOT.

- [ ] **Step 3: Replace the schema**

Replace the entire contents of `src/core/sot-schema.ts`:
```typescript
import { z } from 'zod';

export const SotSchema = z
  .object({
    salon_basics: z
      .object({
        owner_first_name: z.string().min(1),
        salon_name: z.string().min(1),
      })
      .passthrough(),
    booking: z
      .object({
        url: z.string().url(),
      })
      .passthrough(),
    price_quoting_policy: z.enum(['a', 'b', 'c']),
  })
  .passthrough();

export type Sot = z.infer<typeof SotSchema>;
```

- [ ] **Step 4: Run test — expect PASS**

Run: `npx vitest run tests/unit/core/sot-schema.spec.ts`
Expected: 6 tests pass.

- [ ] **Step 5: Note the transient build break, commit schema alone**

Run: `npm run build`
Expected: TS errors in `src/prompt/build.ts`, `src/core/generate-response.ts`, `src/core/handle-inbound.ts` (they read `sot.salon.*`). These are resolved in Tasks 3-4. Test fixtures also break — resolved in Tasks 3-5.

```bash
git add src/core/sot-schema.ts tests/unit/core/sot-schema.spec.ts
git commit -m "feat(sot): new SOT schema (salon_basics/booking/price_quoting_policy, medium-strict passthrough)

Consumers updated in follow-up commits."
```

---

## Task 3: buildPrompt restructure

**Files:**
- Modify: `src/prompt/build.ts`
- Modify: `tests/unit/prompt/build.spec.ts`

- [ ] **Step 1: Update build.spec.ts fixture to new SOT structure**

In `tests/unit/prompt/build.spec.ts`, the `makeSalon()` helper currently builds `sourceOfTruth: { salon: { name, owner_first_name, booking_link } }`. Replace that block with the new structure, and keep the rest of the test file's structure:
```typescript
    sourceOfTruth: {
      salon_basics: {
        salon_name: 'Test Salon',
        owner_first_name: 'Renata',
      },
      booking: {
        url: 'https://book.test/x',
      },
      price_quoting_policy: 'b',
    } as Salon['sourceOfTruth'],
```

Then add two assertions to the existing `describe('buildPrompt multimodal output', ...)` block (or a new describe) verifying the new system prompt assembly:
```typescript
  it('system prompt contains the verbatim booking URL header', () => {
    const ctx = baseCtx([makeMsg('m1', 'inbound', 'hi')]);
    const result = buildPrompt({ salon: makeSalon(), ctx, bookingLinkRecentlySent: false, imagesByMessageId: new Map() });
    expect(result.systemPrompt).toContain('https://book.test/x');
    expect(result.systemPrompt).toContain('PASTE VERBATIM');
  });

  it('system prompt contains conversation state and knowledge base sections', () => {
    const ctx = baseCtx([makeMsg('m1', 'inbound', 'hi')]);
    const result = buildPrompt({ salon: makeSalon(), ctx, bookingLinkRecentlySent: false, imagesByMessageId: new Map() });
    expect(result.systemPrompt).toContain('# Conversation state');
    expect(result.systemPrompt).toContain('# Knowledge base');
    expect(result.systemPrompt).toContain('Total inbound messages this conversation: 1');
  });

  it('system prompt includes the master prompt body', () => {
    const ctx = baseCtx([makeMsg('m1', 'inbound', 'hi')]);
    const result = buildPrompt({ salon: makeSalon(), ctx, bookingLinkRecentlySent: false, imagesByMessageId: new Map() });
    expect(result.systemPrompt).toContain('IDENTITY AND VOICE');
  });
```

- [ ] **Step 2: Run test — expect FAIL** (old build.ts reads `sot.salon.*`, won't compile / wrong assembly)

Run: `npx vitest run tests/unit/prompt/build.spec.ts`
Expected: TS/compile error on `sot.salon.owner_first_name` or assertion failures.

- [ ] **Step 3: Rewrite build.ts**

Replace the entire contents of `src/prompt/build.ts`:
```typescript
import type { Salon, ConversationContext } from '../core/types.js';
import type { ContentBlock } from '../llm/client.js';
import type { ProcessedImage } from '../images/process.js';
import { loadMasterPrompt } from './load-master-prompt.js';

export interface BuildPromptInput {
  salon: Salon;
  ctx: ConversationContext;
  bookingLinkRecentlySent: boolean;
  imagesByMessageId: Map<string, ProcessedImage[]>;
}

export interface BuildPromptOutput {
  systemPrompt: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string | ContentBlock[] }>;
}

export function buildPrompt(input: BuildPromptInput): BuildPromptOutput {
  const { salon, ctx, bookingLinkRecentlySent, imagesByMessageId } = input;
  const sot = salon.sourceOfTruth;
  const bookingUrl = sot.booking.url;
  const state = ctx.conversation.state;
  const inboundCount = ctx.recentMessages.filter((m) => m.direction === 'inbound').length;

  const bookingHeader = `# BOOKING URL (PASTE VERBATIM)
The booking URL is: ${bookingUrl}
Paste it exactly, character for character, whenever you share it. Never paraphrase, shorten, or describe it.`;

  const conversationState = `# Conversation state
- Booking link sent in last ${salon.config.booking_link_dedup_window} messages: ${bookingLinkRecentlySent}
- Total inbound messages this conversation: ${inboundCount}
- State flags JSON: ${JSON.stringify(state)}`;

  const knowledgeBase = `# Knowledge base
${JSON.stringify(sot, null, 2)}`;

  const systemPrompt = [bookingHeader, loadMasterPrompt(), conversationState, knowledgeBase].join('\n\n');

  const messages: BuildPromptOutput['messages'] = [];
  for (const m of ctx.recentMessages) {
    if (m.direction === 'inbound') {
      const imgs = imagesByMessageId.get(m.id);
      if (imgs && imgs.length > 0) {
        const blocks: ContentBlock[] = [];
        for (const img of imgs) blocks.push({ type: 'image', mediaType: img.mediaType, base64: img.base64 });
        blocks.push({ type: 'text', text: m.textContent ?? '[image only, no caption]' });
        messages.push({ role: 'user', content: blocks });
      } else {
        messages.push({ role: 'user', content: m.textContent ?? '' });
      }
    } else if (m.direction === 'outbound' || m.direction === 'owner') {
      messages.push({ role: 'assistant', content: m.textContent ?? '' });
    }
  }

  return { systemPrompt, messages };
}
```

- [ ] **Step 4: Run test — expect PASS**

Run: `npx vitest run tests/unit/prompt/build.spec.ts`
Expected: all build.spec.ts tests pass (existing multimodal tests + 3 new prompt-assembly tests).

- [ ] **Step 5: Commit**

```bash
git add src/prompt/build.ts tests/unit/prompt/build.spec.ts
git commit -m "feat(prompt): buildPrompt assembles booking header + master prompt + state + KB"
```

---

## Task 4: Code path updates (generate-response, handle-inbound) + their fixtures

**Files:**
- Modify: `src/core/generate-response.ts`
- Modify: `src/core/handle-inbound.ts`
- Modify: `tests/unit/core/generate-response-images.spec.ts`
- Modify: `tests/unit/core/handle-inbound.spec.ts`
- Modify: `tests/unit/core/canned-messages.spec.ts`
- Modify: `tests/unit/core/auth-fail.spec.ts`

- [ ] **Step 1: Update generate-response.ts SOT reads**

In `src/core/generate-response.ts`, change three reads:
- `salon.sourceOfTruth.salon.booking_link` (sanitizer bookingLink, ~line 229) → `salon.sourceOfTruth.booking.url`
- `salon.sourceOfTruth.salon.owner_first_name` (escalation fallback owner, ~line 245) → `salon.sourceOfTruth.salon_basics.owner_first_name`
- `salon.sourceOfTruth.salon.booking_link` (contains-link check, ~line 325) → `salon.sourceOfTruth.booking.url`

Use Grep to find exact lines: `grep -n "sourceOfTruth.salon" src/core/generate-response.ts`

- [ ] **Step 2: Update handle-inbound.ts SOT read**

In `src/core/handle-inbound.ts`, change:
- `salon.sourceOfTruth.salon.owner_first_name` (canned reassurance owner, ~line 136) → `salon.sourceOfTruth.salon_basics.owner_first_name`

- [ ] **Step 3: Update the four unit-test fixtures to new SOT structure**

In each of these files, find the `sourceOfTruth` object literal and convert from old to new structure.

`tests/unit/core/canned-messages.spec.ts` — change:
```typescript
    sourceOfTruth: { salon: { owner_first_name: 'Sarah' } } as Salon['sourceOfTruth'],
```
to:
```typescript
    sourceOfTruth: { salon_basics: { owner_first_name: 'Renata', salon_name: 'Lumen' }, booking: { url: 'https://book.test/x' }, price_quoting_policy: 'b' } as Salon['sourceOfTruth'],
```

`tests/unit/core/auth-fail.spec.ts` — find the `sourceOfTruth: {` block and replace with the same new-structure object (owner_first_name + salon_name + booking.url + price_quoting_policy). Read the file first to match its exact local variable/format.

`tests/unit/core/handle-inbound.spec.ts` — find the `sourceOfTruth: {` block (around line 51) and replace with the new-structure object. Ensure `salon_basics.owner_first_name` is present (the canned reassurance reads it).

`tests/unit/core/generate-response-images.spec.ts` — find the `sourceOfTruth: {` block (around line 59) and replace with the new-structure object. Ensure `booking.url` is present (sanitizer dedup reads it).

For all four: the minimum required shape for code to work is:
```typescript
{
  salon_basics: { owner_first_name: '<name>', salon_name: '<name>' },
  booking: { url: 'https://book.test/x' },
  price_quoting_policy: 'b',
} as Salon['sourceOfTruth']
```
Adjust the owner name / URL to whatever each test asserts on (if a test asserts the canned message contains a specific owner name, use that name).

- [ ] **Step 4: Build check**

Run: `npm run build`
Expected: `src/core/generate-response.ts` and `src/core/handle-inbound.ts` now compile. Remaining break only in `tests/unit/ghl/factory.spec.ts` and e2e fixtures (Task 5). `src/db/repos/salons.ts` uses `SotSchema.parse` generically — should compile (no `.salon` access).

Verify salons.ts has no `.salon` SOT access:
```bash
grep -n "sourceOfTruth.salon\b\|\.salon\." src/db/repos/salons.ts
```
Expected: no matches (salons.ts only does `SotSchema.parse`).

- [ ] **Step 5: Run the affected unit tests**

Run: `npx vitest run tests/unit/core/generate-response-images.spec.ts tests/unit/core/handle-inbound.spec.ts tests/unit/core/canned-messages.spec.ts tests/unit/core/auth-fail.spec.ts`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/core/generate-response.ts src/core/handle-inbound.ts tests/unit/core/generate-response-images.spec.ts tests/unit/core/handle-inbound.spec.ts tests/unit/core/canned-messages.spec.ts tests/unit/core/auth-fail.spec.ts
git commit -m "feat(core): read owner/booking from new SOT paths (salon_basics/booking)"
```

---

## Task 5: Remaining fixtures + e2e migration (full green)

**Files:**
- Modify: `tests/unit/ghl/factory.spec.ts`
- Create: `tests/e2e/fixtures/salon-lumen.json`
- Delete: `tests/e2e/fixtures/salon-bella.json`
- Modify: `tests/e2e/01-simple-qa.spec.ts` … `06-image-handling.spec.ts` (fixture filename ref)
- Modify: `tests/e2e/03-escalate-tool.spec.ts` (owner path access)
- Modify: `tests/e2e/06-image-handling.spec.ts` (booking path access)

- [ ] **Step 1: Update ghl/factory.spec.ts fixture**

In `tests/unit/ghl/factory.spec.ts`, change:
```typescript
    sourceOfTruth: { salon: { booking_link: 'https://x/book' } } as Salon['sourceOfTruth'],
```
to:
```typescript
    sourceOfTruth: { salon_basics: { owner_first_name: 'Renata', salon_name: 'Lumen' }, booking: { url: 'https://x/book' }, price_quoting_policy: 'b' } as Salon['sourceOfTruth'],
```

- [ ] **Step 2: Create the new Lumen e2e fixture**

Create `tests/e2e/fixtures/salon-lumen.json`. Use the new SOT structure with a config block matching the old fixture's operational fields (the e2e tests need `config.response_delay_ms` small and `ghl_custom_field_ids` present):
```json
{
  "display_name": "Lumen Hair Studio",
  "ghl_location_id": "loc_lumen_test",
  "ghl_pit": "test-pit",
  "source_of_truth": {
    "salon_basics": {
      "salon_name": "Lumen Hair Studio",
      "owner_first_name": "Renata",
      "address": "1847 Pearl Street, Suite 3, Denver, CO 80203",
      "instagram_handle": "@lumenhairstudio",
      "website_url": "https://lumenhairstudio.com"
    },
    "booking": {
      "platform": "GlossGenius",
      "url": "https://lumenhairstudio.glossgenius.com/book",
      "consultations_bookable_here": true
    },
    "price_quoting_policy": "b",
    "service_menu": {
      "color": "Balayage, foilayage, highlights, root touch-ups, color correction by Renata."
    },
    "pricing": [
      { "service_name": "Full Balayage", "category": "Color", "price": "$220-$320" }
    ],
    "policies": {
      "cancellation": "24 hour notice required."
    },
    "voice_and_tone_notes": "Warm but grounded, not bubbly or salesy."
  },
  "config": {
    "response_delay_ms": 100,
    "ghl_custom_field_ids": {
      "needs_owner_attention": "field_attn",
      "bot_paused_until": "field_paused",
      "last_escalation_reason": "field_reason"
    }
  }
}
```

- [ ] **Step 3: Delete the old Bella fixture**

```bash
git rm tests/e2e/fixtures/salon-bella.json
```

- [ ] **Step 4: Update e2e fixture filename references**

Each e2e spec loads `salon-bella.json`. Grep and update:
```bash
grep -rln "salon-bella.json" tests/e2e/
```
In every match, replace `salon-bella.json` with `salon-lumen.json`.

- [ ] **Step 5: Update e2e SOT path accesses**

`tests/e2e/03-escalate-tool.spec.ts` — change:
```typescript
expect(outbound[0].text_content).toContain(fixture.source_of_truth.salon.owner_first_name);
```
to:
```typescript
expect(outbound[0].text_content).toContain(fixture.source_of_truth.salon_basics.owner_first_name);
```

`tests/e2e/06-image-handling.spec.ts` — change:
```typescript
output: { text: `love that 🤍 grab a consultation here ${fixture.source_of_truth.salon.booking_link}` },
```
to:
```typescript
output: { text: `love that 🤍 grab a consultation here ${fixture.source_of_truth.booking.url}` },
```

Also check 06 for any other `.salon.booking_link` / assertion on booking link and update to `.booking.url`.

- [ ] **Step 6: Full build + full test suite**

Run: `npm run build`
Expected: 0 TS errors (transient break from Task 2 fully resolved).

Run: `npx vitest run tests/unit/`
Expected: all unit tests pass.

Note: e2e tests require Postgres + Redis. If unavailable in the environment they skip/fail on connection (pre-existing behavior) — that's acceptable. If infra is available, they should pass with the new fixture.

- [ ] **Step 7: Commit**

```bash
git add tests/unit/ghl/factory.spec.ts tests/e2e/
git commit -m "test: migrate all fixtures to new SOT structure, swap Bella->Lumen fixture"
```

---

## Task 6: Production data migration (Bella → Lumen, clean slate)

**Files:**
- Create: `scratch/lumen-sot.json` (full Lumen SOT from the provided document)
- Create: `scratch/migrate-bella-to-lumen.ts`

This task mutates the production DB. Run only after Tasks 1-5 are merged and deployed.

- [ ] **Step 1: Save the full Lumen SOT**

Create `scratch/lumen-sot.json` with the **complete** content of the user-provided `Lumen_Hair_Studio_SOT.json` (all sections: salon_basics, stylist_directory, service_menu, pricing, booking, policies, price_quoting_policy, faq, off_limits_topics, voice_and_tone_notes, handoff_notification). This is the rich KB the model will read.

- [ ] **Step 2: Write the migration script**

Create `scratch/migrate-bella-to-lumen.ts`:
```typescript
// One-off production migration: clean slate + Bella -> Lumen in-place update.
// Usage: DATABASE_URL='postgres://...' npx tsx scratch/migrate-bella-to-lumen.ts
//
// Reuses the existing salon row (keeps ghl_location_id, ghl_pit, config,
// custom field ids). Replaces display_name + source_of_truth with Lumen.
// Clears all conversation history for the salon first (clean test slate).

import { Client } from 'pg';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SotSchema } from '../src/core/sot-schema.js';

const SALON_ID = 'bc886868-f2e0-4326-a743-eb2ade42c1cb';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('ERROR: DATABASE_URL not set.');
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const lumenSot = JSON.parse(readFileSync(join(here, 'lumen-sot.json'), 'utf-8'));

// Validate before touching the DB.
SotSchema.parse(lumenSot);
console.log('Lumen SOT passed SotSchema validation.');

const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();

try {
  await client.query('BEGIN');

  // Clean slate: delete conversation history for this salon (children first).
  const convIds = await client.query(
    'SELECT id FROM conversations WHERE salon_id = $1',
    [SALON_ID],
  );
  const ids = convIds.rows.map((r) => r.id);
  console.log(`Found ${ids.length} conversation(s) to clear.`);

  if (ids.length > 0) {
    await client.query('DELETE FROM conversation_events WHERE conversation_id = ANY($1)', [ids]);
    await client.query('DELETE FROM escalations WHERE conversation_id = ANY($1)', [ids]);
    await client.query('DELETE FROM messages WHERE conversation_id = ANY($1)', [ids]);
    await client.query('DELETE FROM conversations WHERE salon_id = $1', [SALON_ID]);
  }

  // In-place content swap (keeps GHL binding + config).
  const res = await client.query(
    `UPDATE salons
     SET display_name = $1, source_of_truth = $2::jsonb, updated_at = now()
     WHERE id = $3
     RETURNING id, display_name`,
    ['Lumen Hair Studio', JSON.stringify(lumenSot), SALON_ID],
  );
  if (res.rowCount !== 1) {
    throw new Error(`Expected to update 1 salon, updated ${res.rowCount}. Aborting.`);
  }

  await client.query('COMMIT');
  console.log('Migration committed:', res.rows[0]);
} catch (err) {
  await client.query('ROLLBACK');
  console.error('Migration rolled back:', err);
  process.exitCode = 1;
} finally {
  await client.end();
}
```

- [ ] **Step 3: Verify FK delete order against the schema**

Read `src/db/migrations/0001_initial.ts` and confirm the foreign-key relationships and whether any are `ON DELETE CASCADE`. If `conversations` children cascade, the explicit child deletes are harmless (idempotent). If not, the explicit order (events, escalations, messages, then conversations) is required. Adjust the script if the schema reveals additional child tables referencing `conversation_id`.

```bash
grep -n "references\|onDelete\|conversation_id\|foreign" src/db/migrations/0001_initial.ts
```

- [ ] **Step 4: Dry-run mentally / run against production**

Run (with the production DATABASE_URL the user provides):
```bash
DATABASE_URL='<render external url>' npx tsx scratch/migrate-bella-to-lumen.ts
```
Expected output: `Lumen SOT passed SotSchema validation.` → `Found N conversation(s) to clear.` → `Migration committed: { id: '...', display_name: 'Lumen Hair Studio' }`.

- [ ] **Step 5: Verify with the existing list script**

Run:
```bash
DATABASE_URL='<render external url>' npx tsx scratch/list-salons.ts
```
Expected: one salon, `display_name: 'Lumen Hair Studio'`, `salon_name: 'Lumen Hair Studio'`, `owner: 'Renata'`, image_proc still set per prior config.

- [ ] **Step 6: Commit the migration artifacts**

```bash
git add scratch/lumen-sot.json scratch/migrate-bella-to-lumen.ts
git commit -m "chore(data): Bella->Lumen migration script + Lumen SOT"
```

---

## Final verification

- [ ] **Step 1: Full suite**

Run: `npx vitest run`
Expected: all unit tests pass; e2e pass if infra available (else skip on connection).

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: clean tsc + `copied master-prompt.md -> dist/prompt`.

- [ ] **Step 3: Manual production check (after deploy)**

Send a text DM and an image DM to the Lumen (reused GHL) location. Confirm the bot replies with Lumen context: Renata as owner, GlossGenius booking link, Lumen services. Confirm the booking URL is pasted verbatim.

---

## Out of scope (per spec)

- Per-salon prompt overrides
- Multi-salon onboarding runbook
- Tool schema changes / new tools
- Image pipeline / sanitizer / GHL client changes
- Removing image-handling diagnostic logs (separate cleanup)
- Dual-schema support (old SOT format fully abandoned)

## Self-Review

**Spec coverage:**
- Spec §2.1 (prompt storage + loading) → Task 1 ✓
- Spec §2.2 (SOT schema) → Task 2 ✓
- Spec §2.3 (buildPrompt restructure) → Task 3 ✓
- Spec §2.4 (code path updates) → Task 4 ✓
- Spec §3 (test/fixture migration) → Tasks 3, 4, 5 ✓
- Spec §4 (data migration) → Task 6 ✓
- Spec §5 (testing) → per-task tests + Final verification ✓

**Placeholder scan:** Master prompt content references the external provided document (not reproduced inline) — acceptable since it's a verbatim copy of a user-supplied artifact with a defined transformation (mojibake → 🤍). Lumen SOT similarly references the provided document. All TS code is complete and inline.

**Type consistency:**
- `Sot` type from Task 2 (`salon_basics`, `booking`, `price_quoting_policy`) used consistently in Tasks 3, 4, 5 fixtures ✓
- `buildPrompt` signature (`BuildPromptInput` object) unchanged from predecessor feature ✓
- New SOT paths (`salon_basics.owner_first_name`, `booking.url`) consistent across build.ts, generate-response.ts, handle-inbound.ts, and all fixtures ✓
- `loadMasterPrompt()` defined in Task 1, consumed in Task 3 ✓
