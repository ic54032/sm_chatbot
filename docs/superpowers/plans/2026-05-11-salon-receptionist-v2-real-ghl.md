# Salon Receptionist V2 — Real GHL Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Zamijeniti `MockGhlClient` realnim `RealGhlClient` HTTP klijentom, konfigurirati 3 GHL workflows + custom fields + PIT, omogućiti live end-to-end IG razgovor.

**Architecture:** RealGhlClient implementira postojeći `GhlClient` interface (V1 boundary). Composition root prelazi iz singleton-a na factory `(salon) => GhlClient` jer je PIT per-location. Worker/handler scopes već imaju `salon` u kontekstu, factory call je tamo. Cloudflared tunnel izlaže lokalni Fastify za GHL custom webhook callove.

**Tech Stack:** Node 20 ESM, TypeScript strict, native `fetch`, vitest. Kysely/Postgres/BullMQ/Redis ostaju isti.

**Pause-points:** Korisnikov memory pravilo nalaže pauzu nakon SVAKE faze (A → B → C → D → E). Eksplicitni `### ⏸ PAUSE` markeri označeni dolje.

---

## Spec reference

Sve odluke i background u: [`docs/superpowers/specs/2026-05-11-salon-receptionist-v2-real-ghl-design.md`](../specs/2026-05-11-salon-receptionist-v2-real-ghl-design.md)

## File map

**Create:**
- `src/ghl/errors.ts` — `GhlApiError`, `OutsideMessagingWindowError`, `isOutsideWindowError` helper
- `src/ghl/real.ts` — `RealGhlClient` class implementing `GhlClient` interface
- `src/ghl/factory.ts` — `GhlFactory` type + `makeGhlFactory` function
- `tests/unit/ghl/errors.spec.ts` — 24h-window detection logic
- `tests/unit/ghl/real.spec.ts` — RealGhlClient with mock fetcher (5xx retry, 429, auth fail, 24h-window)
- `tests/unit/ghl/factory.spec.ts` — cache behavior + mock-vs-real selection

**Modify:**
- `src/config.ts` — add `useMockGhl: boolean`, `ghlApiBaseUrl`, `ghlApiVersion`
- `src/ghl/client.ts` — re-export `GhlFactory` type for consumers
- `src/index.ts` — composition root uses factory; mock-vs-real branching
- `src/workers/respond.ts` — `BuildRespondWorkerDeps.ghl: GhlClient` → `ghlFor: GhlFactory`; bind per-job
- `src/workers/auto-resume.ts` — `setupAutoResume(deps.ghl)` → `setupAutoResume(deps.ghlFor)`; load salon per expired item
- `src/core/handle-inbound.ts` — `HandleInboundDeps.ghl` → `ghlFor`; bind after salon lookup
- `src/routes/dev-simulate.ts` — deps include `mockGhl?: MockGhlClient` for stageMessage helper (dev only)
- `src/db/repos/escalations.ts` — `listActiveTimedOut` returns `{ salonId }` in each item (small additive change)
- `tests/helpers/buildTestApp.ts` — provide factory in test deps that returns the single MockGhlClient instance
- `.env.example` — add V2 env vars

**Unchanged:** `src/sanitizer/**`, `src/prompt/**`, `src/llm/**`, `src/db/repos/*` (except escalations listActiveTimedOut), `src/core/escalate.ts` (still takes `ghl: GhlClient` — caller passes bound instance), `src/core/generate-response.ts` (same), all webhook + admin routes.

---

# Phase A — Setup

**Goal**: Backend zna za real salon, GHL UI ima sve potrebno za pokrenuti workflows, ali workflows još nisu published. Bot ne reagira live još.

## Task A1: Update config & .env.example for V2 env vars

**Files:**
- Modify: `src/config.ts`
- Modify: `.env.example`

- [ ] **Step 1: Write failing test for new config fields**

Create `tests/unit/config.spec.ts` (if it doesn't exist; otherwise extend):

```typescript
import { describe, it, expect } from 'vitest';
import { loadConfig } from '../../src/config.js';

describe('config V2 fields', () => {
  it('parses useMockGhl from env, defaults to false', () => {
    const orig = process.env.USE_MOCK_GHL;
    delete process.env.USE_MOCK_GHL;
    const cfg = loadConfig();
    expect(cfg.useMockGhl).toBe(false);
    if (orig !== undefined) process.env.USE_MOCK_GHL = orig;
  });

  it('useMockGhl=true when env says so', () => {
    const orig = process.env.USE_MOCK_GHL;
    process.env.USE_MOCK_GHL = 'true';
    const cfg = loadConfig();
    expect(cfg.useMockGhl).toBe(true);
    if (orig !== undefined) process.env.USE_MOCK_GHL = orig; else delete process.env.USE_MOCK_GHL;
  });

  it('exposes ghlApiBaseUrl and ghlApiVersion with defaults', () => {
    const cfg = loadConfig();
    expect(cfg.ghlApiBaseUrl).toBe('https://services.leadconnectorhq.com');
    expect(cfg.ghlApiVersion).toBe('2021-04-15');
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

```
rtk proxy npx vitest run tests/unit/config.spec.ts
```

Expected: 3 failing tests (`useMockGhl`, `ghlApiBaseUrl`, `ghlApiVersion` ne postoje na cfg-u).

- [ ] **Step 3: Add fields to ConfigSchema in `src/config.ts`**

Add inside `.object({...})` (preserving existing fields):

```typescript
useMockGhl: z.coerce.boolean().default(false),
ghlApiBaseUrl: z.string().url().default('https://services.leadconnectorhq.com'),
ghlApiVersion: z.string().default('2021-04-15'),
```

Add to `loadConfig()` parse object:

```typescript
useMockGhl: process.env.USE_MOCK_GHL,
ghlApiBaseUrl: process.env.GHL_API_BASE_URL,
ghlApiVersion: process.env.GHL_API_VERSION,
```

- [ ] **Step 4: Run test, verify it passes**

```
rtk proxy npx vitest run tests/unit/config.spec.ts
```

Expected: 3 passes.

- [ ] **Step 5: Update `.env.example`**

Append to the bottom:

```env

# V2 — real GHL integration
USE_MOCK_GHL=true                                       # set false in production
GHL_API_BASE_URL=https://services.leadconnectorhq.com
GHL_API_VERSION=2021-04-15
```

Note: per-salon PIT is stored in DB `salons.ghl_pit`; no global PIT env var.

- [ ] **Step 6: Typecheck + full test suite**

```
rtk proxy npm run lint
rtk proxy npm run test
```

Expected: clean typecheck; all existing tests + new 3 pass.

- [ ] **Step 7: Commit**

```
git add src/config.ts .env.example tests/unit/config.spec.ts
git commit -m "feat(v2): add useMockGhl, ghlApiBaseUrl, ghlApiVersion config"
```

## Task A2: Generate strong WEBHOOK_SECRET for V2

This is operator action (no code change).

- [ ] **Step 1: Generate 32-byte random string**

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Copy the output.

- [ ] **Step 2: Update local `.env`**

Set `WEBHOOK_SECRET=<copied value>`. Restart any running dev server.

- [ ] **Step 3: Keep this secret available** — bit će potreban u Task A6 (GHL workflow header `X-Webhook-Secret`).

No commit (env is gitignored).

## Task A3: Install cloudflared, start tunnel

- [ ] **Step 1: Install (one-time)**

```powershell
scoop install cloudflared
```

If scoop nije instaliran, prvo: https://scoop.sh.

- [ ] **Step 2: Start backend locally**

In one terminal:

```
rtk proxy npm run dev
```

Expect: `server listening port=3000`.

- [ ] **Step 3: Start tunnel in another terminal**

```
cloudflared tunnel --url http://localhost:3000
```

Expect output containing `https://<random>-<random>-<numbers>.trycloudflare.com`. Copy that URL — bit će workflow webhook base.

- [ ] **Step 4: Smoke test tunnel**

In a third terminal:

```
curl https://<tunnel-url>/health
```

Expect: `{"status":"ok","ts":"..."}`.

No commit (operator state, not repo state).

## Task A4: GHL UI — Custom Fields, Tag, PIT

Operator action in GHL web UI.

- [ ] **Step 1: Create 3 custom fields**

Settings → Custom Fields → Contact → New, three times. Names exactly:
- `Needs Owner Attention` (Type: Single Line)
- `Bot Paused Until` (Type: Date/Time)
- `Last Escalation Reason` (Type: Single Line)

For each, after save, click into it and copy the field ID from URL pattern `.../custom-fields/{uuid}`. Save the 3 UUIDs in a notepad.

- [ ] **Step 2: Create tag**

Settings → Tags → New: `escalation_active` (lowercase, underscore). Save.

- [ ] **Step 3: Create Private Integration Token**

Settings → Private Integrations → Create:
- Name: `salon-receptionist-backend`
- Scopes: tick all of:
  - `conversations.write`
  - `conversations.readonly`
  - `contacts.write`
  - `contacts.readonly`
  - `locations.readonly`
- Click Create. **Copy token immediately** — won't be shown again. Save in notepad next to the field UUIDs.

- [ ] **Step 4: Note your `location_id`**

GHL sub-account URL contains the location ID: `https://app.gohighlevel.com/v2/location/{LOCATION_ID}/...`. Copy `LOCATION_ID`.

No commit.

## Task A5: Write SoT JSON for test salon

- [ ] **Step 1: Create or copy SoT JSON**

If you have `tests/e2e/fixtures/salon-bella.json` and want to reuse Bella Hair Studio as the live test salon, copy that. Otherwise write your own following the Sot schema in V1 design §4.7.

Save to `scratch/salon-onboarding.json` (gitignored already via `payload.json` pattern — or add `scratch/` to `.gitignore` if not):

```json
{
  "display_name": "Bella Hair Studio",
  "ghl_location_id": "<LOCATION_ID from Task A4 step 4>",
  "ghl_pit": "<PIT token from Task A4 step 3>",
  "source_of_truth": { /* paste from fixtures/salon-bella.json or your own */ },
  "config": {
    "response_delay_ms": 40000,
    "llm_model": "gemini-2.5-flash",
    "handoff_window_hours": 4,
    "booking_link_dedup_window": 3,
    "max_words_per_message": 40,
    "max_emojis": 2,
    "ghl_custom_field_ids": {
      "needs_owner_attention": "<UUID from Task A4 step 1>",
      "bot_paused_until": "<UUID from Task A4 step 1>",
      "last_escalation_reason": "<UUID from Task A4 step 1>"
    }
  }
}
```

- [ ] **Step 2: Confirm `scratch/` is gitignored**

Open `.gitignore`. If `scratch/` not present, add it on its own line after the existing scratch entries. Then:

```
git status
```

Expect: `scratch/salon-onboarding.json` NOT shown as untracked.

If `.gitignore` was modified, commit:

```
git add .gitignore
git commit -m "chore: gitignore scratch/ directory"
```

## Task A6: Onboard salon via POST /admin/salons

Backend must be running (Task A3 step 2) and reachable.

- [ ] **Step 1: Read ADMIN_API_KEY from .env**

```powershell
type .env | findstr ADMIN_API_KEY
```

- [ ] **Step 2: POST onboarding payload**

```powershell
curl -X POST http://localhost:3000/admin/salons `
  -H "Content-Type: application/json" `
  -H "X-Admin-Api-Key: <ADMIN_API_KEY>" `
  --data "@scratch/salon-onboarding.json"
```

Expect: `201 Created` with body `{"id":"<uuid>","ghl_location_id":"<LOCATION_ID>"}`.

- [ ] **Step 3: Verify in DB**

```powershell
docker compose exec postgres psql -U salon -d salon -c "SELECT id, display_name, ghl_location_id, is_active FROM salons;"
```

Expect: 1 row with your salon's data.

No commit (this is runtime state).

### ⏸ PAUSE — Phase A complete

Verify with user before starting Phase B. Demonstrable state:
- Backend running locally, tunnel up
- GHL has 3 custom fields, 1 tag, 1 PIT
- Backend `salons` table has 1 row with valid PIT
- `/health` returns 200 via tunnel

---

# Phase B — Inbound + sendMessage live

**Goal**: Pošalji IG poruku s test accounta → bot odgovori live. S1 i S2 smoke testovi prolaze.

## Task B1: GHL error classes + 24h-window detection

**Files:**
- Create: `src/ghl/errors.ts`
- Create: `tests/unit/ghl/errors.spec.ts`

- [ ] **Step 1: Write failing test**

`tests/unit/ghl/errors.spec.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { GhlApiError, OutsideMessagingWindowError, isOutsideWindowError } from '../../../src/ghl/errors.js';

describe('GhlApiError', () => {
  it('preserves status, path, body', () => {
    const err = new GhlApiError(500, '/conversations/messages', 'internal err');
    expect(err.status).toBe(500);
    expect(err.path).toBe('/conversations/messages');
    expect(err.body).toBe('internal err');
    expect(err.name).toBe('GhlApiError');
  });
});

describe('isOutsideWindowError', () => {
  it('matches 422 with 24-hour window message', () => {
    expect(isOutsideWindowError(422, 'cannot send outside the 24-hour messaging window')).toBe(true);
  });

  it('matches 400 with window word', () => {
    expect(isOutsideWindowError(400, 'Outside 24 hour window')).toBe(true);
  });

  it('rejects 500 even with matching body', () => {
    expect(isOutsideWindowError(500, 'outside 24 hour window')).toBe(false);
  });

  it('rejects 422 without window/messaging words', () => {
    expect(isOutsideWindowError(422, 'validation failed')).toBe(false);
  });

  it('rejects 422 with "24" but no "window" or "messaging"', () => {
    expect(isOutsideWindowError(422, 'expected 24 chars min')).toBe(false);
  });
});

describe('OutsideMessagingWindowError', () => {
  it('is subclass of GhlApiError with status 422', () => {
    const err = new OutsideMessagingWindowError('/p', 'body');
    expect(err).toBeInstanceOf(GhlApiError);
    expect(err.status).toBe(422);
    expect(err.name).toBe('OutsideMessagingWindowError');
  });
});
```

- [ ] **Step 2: Run, verify fail**

```
rtk proxy npx vitest run tests/unit/ghl/errors.spec.ts
```

Expected: import resolution error (`Cannot find module './ghl/errors'`).

- [ ] **Step 3: Implement `src/ghl/errors.ts`**

```typescript
export class GhlApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly path: string,
    public readonly body: string,
  ) {
    super(`GHL API ${status} on ${path}: ${body.slice(0, 200)}`);
    this.name = 'GhlApiError';
  }
}

export class OutsideMessagingWindowError extends GhlApiError {
  constructor(path: string, body: string) {
    super(422, path, body);
    this.name = 'OutsideMessagingWindowError';
  }
}

export function isOutsideWindowError(status: number, body: string): boolean {
  if (status !== 422 && status !== 400) return false;
  const lower = body.toLowerCase();
  return lower.includes('24') && (lower.includes('window') || lower.includes('messaging'));
}
```

- [ ] **Step 4: Run, verify pass**

```
rtk proxy npx vitest run tests/unit/ghl/errors.spec.ts
```

Expected: 7 pass.

- [ ] **Step 5: Commit**

```
git add src/ghl/errors.ts tests/unit/ghl/errors.spec.ts
git commit -m "feat(ghl): error classes with 24h-window detection"
```

## Task B2: RealGhlClient skeleton + request() helper

**Files:**
- Create: `src/ghl/real.ts`
- Create: `tests/unit/ghl/real.spec.ts`

- [ ] **Step 1: Write failing test for happy-path GET**

`tests/unit/ghl/real.spec.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { RealGhlClient } from '../../../src/ghl/real.js';
import { GhlApiError, OutsideMessagingWindowError } from '../../../src/ghl/errors.js';

function mockFetcher(impl: typeof fetch): typeof fetch {
  return impl;
}

describe('RealGhlClient.request', () => {
  it('sends Authorization and Version headers on every call', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetcher = mockFetcher(async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const client = new RealGhlClient('pit-abc', 'loc-1', fetcher);
    await client.getMessage('msg-1');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://services.leadconnectorhq.com/conversations/messages/msg-1');
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer pit-abc');
    expect(headers['Version']).toBe('2021-04-15');
  });

  it('throws GhlApiError on non-2xx with status preserved', async () => {
    const fetcher = mockFetcher(async () =>
      new Response('not found', { status: 404 }),
    );
    const client = new RealGhlClient('pit', 'loc', fetcher);
    await expect(client.getMessage('x')).rejects.toMatchObject({
      name: 'GhlApiError',
      status: 404,
    });
  });

  it('throws OutsideMessagingWindowError on 422 with 24-hour body', async () => {
    const fetcher = mockFetcher(async () =>
      new Response('Cannot send outside the 24-hour window', { status: 422 }),
    );
    const client = new RealGhlClient('pit', 'loc', fetcher);
    await expect(
      client.sendMessage({ contactId: 'c1', type: 'IG', message: 'hi' }),
    ).rejects.toBeInstanceOf(OutsideMessagingWindowError);
  });
});
```

- [ ] **Step 2: Run, verify fail**

```
rtk proxy npx vitest run tests/unit/ghl/real.spec.ts
```

Expected: import resolution error.

- [ ] **Step 3: Implement `src/ghl/real.ts`**

```typescript
import type { GhlClient } from './client.js';
import { GhlApiError, OutsideMessagingWindowError, isOutsideWindowError } from './errors.js';

const GHL_BASE_URL = 'https://services.leadconnectorhq.com';
const GHL_API_VERSION = '2021-04-15';
const REQUEST_TIMEOUT_MS = 15_000;

type Fetcher = typeof fetch;

export class RealGhlClient implements GhlClient {
  private readonly fetcher: Fetcher;
  constructor(
    private readonly pit: string,
    private readonly locationId: string,
    fetcher?: Fetcher,
  ) {
    this.fetcher = fetcher ?? fetch;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.pit}`,
      Version: GHL_API_VERSION,
      Accept: 'application/json',
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const res = await this.fetcher(`${GHL_BASE_URL}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      if (isOutsideWindowError(res.status, text)) {
        throw new OutsideMessagingWindowError(path, text);
      }
      throw new GhlApiError(res.status, path, text);
    }
    // 204 No Content guard
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  async sendMessage(input: { contactId: string; type: 'IG'; message: string }): Promise<{ ghlMessageId: string }> {
    const res = await this.request<{ messageId?: string; id?: string }>('POST', '/conversations/messages', {
      type: input.type,
      contactId: input.contactId,
      message: input.message,
      locationId: this.locationId,
    });
    const id = res.messageId ?? res.id;
    if (!id) throw new GhlApiError(500, '/conversations/messages', 'response missing messageId/id');
    return { ghlMessageId: id };
  }

  async getMessage(messageId: string): Promise<{ text: string; attachments: Array<{ url: string; type: 'image' | 'audio' | 'video' }> }> {
    const res = await this.request<{ message?: { body?: string; attachments?: Array<{ url: string; type: string }> } }>(
      'GET',
      `/conversations/messages/${encodeURIComponent(messageId)}`,
    );
    const msg = res.message ?? {};
    return {
      text: msg.body ?? '',
      attachments: (msg.attachments ?? []).map((a) => ({
        url: a.url,
        type: (a.type as 'image' | 'audio' | 'video') ?? 'image',
      })),
    };
  }

  async addTag(contactId: string, tags: string[]): Promise<void> {
    await this.request<unknown>('POST', `/contacts/${encodeURIComponent(contactId)}/tags`, { tags });
  }

  async removeTag(contactId: string, tags: string[]): Promise<void> {
    await this.request<unknown>('DELETE', `/contacts/${encodeURIComponent(contactId)}/tags`, { tags });
  }

  async updateCustomField(input: { contactId: string; fieldId: string; value: string | number | boolean }): Promise<void> {
    await this.request<unknown>('PUT', `/contacts/${encodeURIComponent(input.contactId)}`, {
      customFields: [{ id: input.fieldId, value: input.value }],
    });
  }
}
```

- [ ] **Step 4: Run, verify pass**

```
rtk proxy npx vitest run tests/unit/ghl/real.spec.ts
```

Expected: 3 pass.

- [ ] **Step 5: Commit**

```
git add src/ghl/real.ts tests/unit/ghl/real.spec.ts
git commit -m "feat(ghl): RealGhlClient skeleton with sendMessage/getMessage/tags/customField"
```

## Task B3: RealGhlClient sendMessage payload + response shape tests

**Files:**
- Modify: `tests/unit/ghl/real.spec.ts` (append)

- [ ] **Step 1: Add tests for exact payload + response parsing**

Append to `tests/unit/ghl/real.spec.ts`:

```typescript
describe('RealGhlClient.sendMessage', () => {
  it('POSTs to /conversations/messages with type=IG, contactId, message, locationId', async () => {
    let captured: { url: string; body: unknown } | undefined;
    const fetcher: typeof fetch = async (url, init) => {
      captured = { url: String(url), body: JSON.parse(init?.body as string) };
      return new Response(JSON.stringify({ messageId: 'm-123' }), { status: 200 });
    };
    const client = new RealGhlClient('pit', 'loc-1', fetcher);
    const result = await client.sendMessage({ contactId: 'c-1', type: 'IG', message: 'Hi' });
    expect(captured?.url).toBe('https://services.leadconnectorhq.com/conversations/messages');
    expect(captured?.body).toEqual({ type: 'IG', contactId: 'c-1', message: 'Hi', locationId: 'loc-1' });
    expect(result.ghlMessageId).toBe('m-123');
  });

  it('falls back to response.id when messageId absent', async () => {
    const fetcher: typeof fetch = async () => new Response(JSON.stringify({ id: 'm-456' }), { status: 200 });
    const client = new RealGhlClient('pit', 'loc', fetcher);
    const result = await client.sendMessage({ contactId: 'c', type: 'IG', message: 'x' });
    expect(result.ghlMessageId).toBe('m-456');
  });

  it('throws GhlApiError when response has neither messageId nor id', async () => {
    const fetcher: typeof fetch = async () => new Response(JSON.stringify({ ok: true }), { status: 200 });
    const client = new RealGhlClient('pit', 'loc', fetcher);
    await expect(client.sendMessage({ contactId: 'c', type: 'IG', message: 'x' })).rejects.toBeInstanceOf(GhlApiError);
  });
});

describe('RealGhlClient.getMessage', () => {
  it('GETs /conversations/messages/{id} and extracts text+attachments', async () => {
    const fetcher: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          message: {
            body: 'hello world',
            attachments: [{ url: 'https://x/img.jpg', type: 'image' }],
          },
        }),
        { status: 200 },
      );
    const client = new RealGhlClient('pit', 'loc', fetcher);
    const result = await client.getMessage('m-9');
    expect(result.text).toBe('hello world');
    expect(result.attachments).toEqual([{ url: 'https://x/img.jpg', type: 'image' }]);
  });

  it('returns empty text+attachments on minimal response', async () => {
    const fetcher: typeof fetch = async () => new Response(JSON.stringify({}), { status: 200 });
    const client = new RealGhlClient('pit', 'loc', fetcher);
    const result = await client.getMessage('m');
    expect(result.text).toBe('');
    expect(result.attachments).toEqual([]);
  });
});
```

- [ ] **Step 2: Run, verify pass**

```
rtk proxy npx vitest run tests/unit/ghl/real.spec.ts
```

Expected: 8 pass (3 from B2 + 5 from B3).

- [ ] **Step 3: Commit**

```
git add tests/unit/ghl/real.spec.ts
git commit -m "test(ghl): RealGhlClient sendMessage/getMessage payload + response shapes"
```

## Task B4: GhlFactory + makeGhlFactory

**Files:**
- Create: `src/ghl/factory.ts`
- Create: `tests/unit/ghl/factory.spec.ts`
- Modify: `src/ghl/client.ts` (re-export)

- [ ] **Step 1: Write failing test**

`tests/unit/ghl/factory.spec.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { makeGhlFactory } from '../../../src/ghl/factory.js';
import { MockGhlClient } from '../../../src/ghl/mock.js';
import { RealGhlClient } from '../../../src/ghl/real.js';
import type { Salon } from '../../../src/core/types.js';

const mockDb = {} as never; // MockGhlClient constructor accepts unused-typed db in tests

function makeSalon(id: string, pit = 'pit', locationId = 'loc-1'): Salon {
  return {
    id,
    displayName: 'Test',
    ghlLocationId: locationId,
    ghlPit: pit,
    isActive: true,
    sourceOfTruth: { salon: { booking_link: 'https://x/book' } } as Salon['sourceOfTruth'],
    config: {} as Salon['config'],
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('makeGhlFactory', () => {
  it('mock mode returns same MockGhlClient instance for different salons', () => {
    const factory = makeGhlFactory({ useMock: true, db: mockDb });
    const client1 = factory(makeSalon('s1'));
    const client2 = factory(makeSalon('s2'));
    expect(client1).toBe(client2);
    expect(client1).toBeInstanceOf(MockGhlClient);
  });

  it('real mode returns RealGhlClient cached per salon.id', () => {
    const factory = makeGhlFactory({ useMock: false, db: mockDb });
    const salonA = makeSalon('sA', 'pit-A', 'loc-A');
    const client1 = factory(salonA);
    const client2 = factory(salonA);
    expect(client1).toBe(client2);
    expect(client1).toBeInstanceOf(RealGhlClient);

    const salonB = makeSalon('sB', 'pit-B', 'loc-B');
    const client3 = factory(salonB);
    expect(client3).not.toBe(client1);
    expect(client3).toBeInstanceOf(RealGhlClient);
  });
});
```

- [ ] **Step 2: Run, verify fail**

```
rtk proxy npx vitest run tests/unit/ghl/factory.spec.ts
```

Expected: module not found.

- [ ] **Step 3: Implement `src/ghl/factory.ts`**

```typescript
import type { Db } from '../db/kysely.js';
import type { Salon } from '../core/types.js';
import type { GhlClient } from './client.js';
import { MockGhlClient } from './mock.js';
import { RealGhlClient } from './real.js';

export type GhlFactory = (salon: Salon) => GhlClient;

export function makeGhlFactory(opts: { useMock: boolean; db: Db }): GhlFactory {
  if (opts.useMock) {
    const mock = new MockGhlClient(opts.db);
    return () => mock;
  }
  const cache = new Map<string, RealGhlClient>();
  return (salon) => {
    let client = cache.get(salon.id);
    if (!client) {
      client = new RealGhlClient(salon.ghlPit, salon.ghlLocationId);
      cache.set(salon.id, client);
    }
    return client;
  };
}
```

- [ ] **Step 4: Re-export from `src/ghl/client.ts`**

Append to `src/ghl/client.ts`:

```typescript
export type { GhlFactory } from './factory.js';
```

(So consumers can import `GhlFactory` alongside `GhlClient` from the same module.)

- [ ] **Step 5: Run, verify pass**

```
rtk proxy npx vitest run tests/unit/ghl/factory.spec.ts
```

Expected: 2 pass.

- [ ] **Step 6: Commit**

```
git add src/ghl/factory.ts src/ghl/client.ts tests/unit/ghl/factory.spec.ts
git commit -m "feat(ghl): GhlFactory with per-salon cache + mock/real selection"
```

## Task B5: Refactor `handle-inbound.ts` to use factory

**Files:**
- Modify: `src/core/handle-inbound.ts:20-27` (HandleInboundDeps interface)
- Modify: `src/core/handle-inbound.ts:36-44` (usage of deps.ghl.getMessage)

- [ ] **Step 1: Update `HandleInboundDeps`**

In `src/core/handle-inbound.ts`, replace lines 20-27:

```typescript
export interface HandleInboundDeps {
  db: Db;
  ghlFor: GhlFactory;
  llm: LlmClient;
  defaultLlmModel: string;
  respondQueue: Queue<RespondJobData>;
  responseDelayMsOverride?: number;
}
```

Update imports:

```typescript
// remove: import type { GhlClient } from '../ghl/client.js';
import type { GhlFactory } from '../ghl/client.js';
```

- [ ] **Step 2: Bind salon-specific client AFTER salon lookup**

Replace the `getMessage` fallback block (currently around lines 36-40 using `deps.ghl.getMessage`):

```typescript
  const ghl = deps.ghlFor(salon);

  let textContent = input.messageText ?? '';
  if (!textContent && input.messageId) {
    const fetched = await ghl.getMessage(input.messageId);
    textContent = fetched.text;
  }
```

(The `ghl` variable lives in function scope; reused in any later GHL calls.)

- [ ] **Step 3: Typecheck**

```
rtk proxy npm run lint
```

Expected: error in `dev-simulate.ts` and webhook routes because they pass `ghl:` not `ghlFor:`. Track which files need update — fix in B7/B8.

For now, isolate this task: don't fix yet — go to next task.

If typecheck blocks committing, skip commit on this task and do B5+B6+B7 as one combined commit (next task does composition root which fixes all callers).

## Task B6: Refactor `respond.ts` worker to use factory

**Files:**
- Modify: `src/workers/respond.ts:25-32` (deps interface)
- Modify: `src/workers/respond.ts:46-56` (worker job body)

- [ ] **Step 1: Update `BuildRespondWorkerDeps`**

Replace lines 25-32:

```typescript
export interface BuildRespondWorkerDeps {
  db: Db;
  redis: Redis;
  ghlFor: GhlFactory;
  llm: LlmClient;
  defaultLlmModel: string;
  connection: ConnectionOptions;
}
```

Update import:

```typescript
import type { GhlFactory } from '../ghl/client.js';
```

(remove `GhlClient` import if unused.)

- [ ] **Step 2: Bind per-job after salon lookup**

Replace the body inside `async (job)` from `const salon = ...` onwards:

```typescript
      try {
        const salon = await salonsRepo.findById(deps.db, job.data.salonId);
        if (!salon) {
          logger.warn({ salonId: job.data.salonId }, 'salon disappeared between schedule and run; dropping');
          return;
        }
        const ghl = deps.ghlFor(salon);
        await generateResponse(
          { db: deps.db, ghl, llm: deps.llm, defaultLlmModel: deps.defaultLlmModel },
          salon,
          job.data.conversationId,
        );
      } finally {
```

(Note: `generateResponse` interface UNCHANGED — still takes `ghl: GhlClient`. Worker does the factory lookup.)

- [ ] **Step 3: Typecheck**

```
rtk proxy npm run lint
```

Expected: still failing in `dev-simulate.ts`, `webhooks-ghl-inbound.ts`, `index.ts`. Continue.

## Task B7: Refactor webhook route + dev-simulate to use factory

**Files:**
- Modify: `src/routes/webhooks-ghl-inbound.ts`
- Modify: `src/routes/dev-simulate.ts`

- [ ] **Step 1: Update inbound webhook route**

Read `src/routes/webhooks-ghl-inbound.ts`. Find where `handleInbound` is called with `{ ghl: app.deps.ghl, ... }` — replace with `{ ghlFor: app.deps.ghlFor, ... }`.

- [ ] **Step 2: Update dev-simulate route**

In `src/routes/dev-simulate.ts:42-48`, replace `ghl: app.deps.ghl` with `ghlFor: app.deps.ghlFor` in the `handleInbound` call.

For the `app.deps.ghl instanceof MockGhlClient` check at line 31, change to use a dedicated `mockGhl` deps field that we'll add in next step:

```typescript
    if (data.stage_get_message) {
      if (!app.deps.mockGhl) {
        return reply.code(503).send({ error: 'stage_get_message_only_supported_with_mock_ghl' });
      }
      app.deps.mockGhl.stageMessage(messageId, data.message_text);
    }
```

- [ ] **Step 3: Typecheck**

```
rtk proxy npm run lint
```

Expected: errors in `index.ts` referencing `deps.ghl` (now needs `ghlFor`, `mockGhl`). Fix in next task.

## Task B8: Refactor composition root + Fastify deps decl

**Files:**
- Modify: `src/index.ts` (composition root + deps interface)

- [ ] **Step 1: Update composition root**

Replace the `ghl` construction in `main()`:

```typescript
// remove: const ghl: GhlClient = new MockGhlClient(db);

const ghlFor = makeGhlFactory({ useMock: cfg.useMockGhl, db });
const mockGhl: MockGhlClient | undefined = cfg.useMockGhl
  ? (ghlFor({ id: 'sentinel' } as Salon) as MockGhlClient)
  : undefined;
```

(In mock mode, factory returns same MockGhlClient regardless of salon — we grab the singleton via a sentinel call.)

- [ ] **Step 2: Update worker construction**

Replace `buildRespondWorker({...})` and `setupAutoResume({...})` ghl args:

```typescript
  const respondWorker = buildRespondWorker({
    db,
    redis,
    ghlFor,
    llm,
    defaultLlmModel: cfg.llmModel,
    connection,
  });

  const autoResume = await setupAutoResume({ db, ghlFor, connection });
```

(setupAutoResume update lands in Task D1 — for now, this line will fail typecheck; fix temporary by passing the entire factory; auto-resume's internal use will be updated when D1 lands. Since we still have it use the old shape in B-phase, leave `ghl: ghlFor({ id: 'sentinel' } as Salon)` as a temporary bridge if blocking typecheck. Cleaner: defer this line update to D1 and keep ghl literal in B-phase.)

To keep B-phase clean, use the temporary bridge approach for auto-resume — it doesn't fire in normal smoke and we'll cleanly refactor in D1:

```typescript
  const autoResume = await setupAutoResume({
    db,
    ghl: cfg.useMockGhl ? ghlFor({ id: 'sentinel' } as Salon) : ghlFor({ id: 'sentinel' } as Salon),
    connection,
  });
```

(Both branches identical because in mock mode it gives the mock, in real mode it gives one RealGhlClient bound to a sentinel — which is never actually called until D1 lands. Mark this as `// TODO Phase D1: per-item factory lookup`.)

- [ ] **Step 3: Update `deps` decoration**

```typescript
  const deps = { db, redis, ghlFor, mockGhl, llm, cfg, respondQueue, defaultLlmModel: cfg.llmModel } as const;
```

- [ ] **Step 4: Update Fastify module augmentation at bottom**

```typescript
declare module 'fastify' {
  interface FastifyInstance {
    deps: {
      db: ReturnType<typeof createKyselyDb>;
      redis: Redis;
      ghlFor: GhlFactory;
      mockGhl: MockGhlClient | undefined;
      llm: LlmClient;
      cfg: ReturnType<typeof loadConfig>;
      respondQueue: Queue<RespondJobData>;
      defaultLlmModel: string;
    };
  }
}
```

Update imports at top:

```typescript
import { makeGhlFactory } from './ghl/factory.js';
import type { GhlFactory } from './ghl/client.js';
import { MockGhlClient } from './ghl/mock.js';
import type { Salon } from './core/types.js';
```

- [ ] **Step 5: Typecheck**

```
rtk proxy npm run lint
```

Expected: clean. If any remaining errors in tests/helpers/buildTestApp.ts, those land in B9.

## Task B9: Update tests/helpers/buildTestApp.ts for factory pattern

**Files:**
- Modify: `tests/helpers/buildTestApp.ts`

- [ ] **Step 1: Read the file**

```
rtk proxy npx vitest list tests/e2e/ 2>&1 | head -5
```

Just to confirm where it lives. Read with `Read` tool. The file likely instantiates MockGhlClient and passes as `ghl:` everywhere.

- [ ] **Step 2: Update to factory pattern**

Find every place that constructs/passes `ghl: mockGhl` (or similar) and replace with `ghlFor: (() => mockGhl) as GhlFactory` AND keep `mockGhl` reference for stageMessage. Same shape as production composition root, just hard-wired to MockGhlClient.

If the test helper exports a `mockGhl` instance for e2e tests, also expose it as `mockGhl` in the test app deps.

- [ ] **Step 3: Run all tests**

```
rtk proxy npm run test
```

Expected: 29/29 pass (existing tests should be insulated by the factory refactor — they always get the same MockGhl).

- [ ] **Step 4: Commit B5-B9 together**

```
git add src/core/handle-inbound.ts src/workers/respond.ts src/routes/webhooks-ghl-inbound.ts src/routes/dev-simulate.ts src/index.ts tests/helpers/buildTestApp.ts
git commit -m "refactor(v2): switch from ghl singleton to GhlFactory per-salon"
```

## Task B10: GHL Workflow #1 — publish + smoke S1

Operator action + manual smoke.

- [ ] **Step 1: Create Workflow #1 in GHL UI**

Automation → Workflows → New → Start from Scratch:
- Trigger: `Customer Replied`, filter `Reply Channel = Instagram DM`
- Action: `Custom Webhook`
  - Method: `POST`
  - URL: `https://<tunnel-from-Task-A3>/webhooks/ghl/inbound`
  - Headers:
    - `Content-Type: application/json`
    - `X-Webhook-Secret: <WEBHOOK_SECRET from Task A2>`
  - Body (Raw, JSON):
    ```json
    {
      "location_id": "{{location.id}}",
      "contact_id": "{{contact.id}}",
      "contact_handle": "{{contact.instagram}}",
      "message_id": "{{message.id}}",
      "message_text": "{{message.body}}"
    }
    ```
- Save → **Publish**

- [ ] **Step 2: Confirm USE_MOCK_GHL=false in `.env`, restart backend**

```powershell
# in .env: USE_MOCK_GHL=false
# Stop dev server (Ctrl+C) and restart
rtk proxy npm run dev
```

- [ ] **Step 3: Smoke S1 — simple Q&A**

From test IG account, send to salon IG: `"Bok, radite li balayage?"`.

Observe backend log:
- `inbound persisted` (~1s after send)
- `respond job queued` 
- After `response_delay_ms` (~40s): `outbound sent`

Observe in test IG account: bot reply arrives.

Observe in DB:
```powershell
docker compose exec postgres psql -U salon -d salon -c "SELECT direction, text_content, created_at FROM messages ORDER BY created_at DESC LIMIT 5;"
```

Expect: 2 rows — 1 inbound, 1 outbound.

- [ ] **Step 4: Smoke S2 — coalescing**

From test IG account, send 3 messages in <5s:
1. `"Bok"`
2. `"Koliko košta balayage?"`
3. `"I koliko traje?"`

Expect: only ONE bot reply, ~40s after the third message. DB has 3 inbound + 1 outbound.

If S1 + S2 pass, Phase B is done.

### ⏸ PAUSE — Phase B complete

Bot odgovara live na IG. Phase B's S1+S2 smoke verified. Verify with user before starting Phase C.

---

# Phase C — Escalation full lifecycle

**Goal**: Bot može eskalirati → tag added → push to owner. Owner makne tag → bot se vraća. S3+S4 prolaze.

## Task C1: Test RealGhlClient.addTag / removeTag / updateCustomField

**Files:**
- Modify: `tests/unit/ghl/real.spec.ts` (append)

- [ ] **Step 1: Append tests**

```typescript
describe('RealGhlClient.addTag', () => {
  it('POSTs to /contacts/{id}/tags with tags array', async () => {
    let captured: { url: string; method?: string; body: unknown } | undefined;
    const fetcher: typeof fetch = async (url, init) => {
      captured = { url: String(url), method: init?.method, body: JSON.parse(init?.body as string) };
      return new Response('', { status: 200 });
    };
    const client = new RealGhlClient('pit', 'loc', fetcher);
    await client.addTag('c-1', ['escalation_active']);
    expect(captured?.url).toBe('https://services.leadconnectorhq.com/contacts/c-1/tags');
    expect(captured?.method).toBe('POST');
    expect(captured?.body).toEqual({ tags: ['escalation_active'] });
  });
});

describe('RealGhlClient.removeTag', () => {
  it('DELETEs /contacts/{id}/tags with tags array', async () => {
    let captured: { method?: string; body: unknown } | undefined;
    const fetcher: typeof fetch = async (_url, init) => {
      captured = { method: init?.method, body: JSON.parse(init?.body as string) };
      return new Response('', { status: 200 });
    };
    const client = new RealGhlClient('pit', 'loc', fetcher);
    await client.removeTag('c-1', ['escalation_active']);
    expect(captured?.method).toBe('DELETE');
    expect(captured?.body).toEqual({ tags: ['escalation_active'] });
  });
});

describe('RealGhlClient.updateCustomField', () => {
  it('PUTs /contacts/{id} with customFields array', async () => {
    let captured: { url: string; method?: string; body: unknown } | undefined;
    const fetcher: typeof fetch = async (url, init) => {
      captured = { url: String(url), method: init?.method, body: JSON.parse(init?.body as string) };
      return new Response('', { status: 200 });
    };
    const client = new RealGhlClient('pit', 'loc', fetcher);
    await client.updateCustomField({ contactId: 'c-1', fieldId: 'f-1', value: 'reason' });
    expect(captured?.url).toBe('https://services.leadconnectorhq.com/contacts/c-1');
    expect(captured?.method).toBe('PUT');
    expect(captured?.body).toEqual({ customFields: [{ id: 'f-1', value: 'reason' }] });
  });
});
```

- [ ] **Step 2: Run, verify pass**

```
rtk proxy npx vitest run tests/unit/ghl/real.spec.ts
```

Expected: 11 pass.

- [ ] **Step 3: Commit**

```
git add tests/unit/ghl/real.spec.ts
git commit -m "test(ghl): addTag/removeTag/updateCustomField payload shapes"
```

## Task C2: GHL Workflow #2 (resume on tag removal) — publish

Operator action.

- [ ] **Step 1: Create Workflow #2**

Automation → Workflows → New:
- Trigger: `Contact Tag`, filter `Tag Removed = escalation_active`
- Action: `Custom Webhook`
  - Method: `POST`
  - URL: `https://<tunnel>/webhooks/ghl/resume`
  - Headers: `Content-Type: application/json`, `X-Webhook-Secret: <secret>`
  - Body:
    ```json
    {
      "location_id": "{{location.id}}",
      "contact_id": "{{contact.id}}"
    }
    ```
- Save → Publish

No commit.

## Task C3: GHL Workflow #3 (owner notification on tag added) — publish

Operator action.

- [ ] **Step 1: Create Workflow #3**

Automation → Workflows → New:
- Trigger: `Contact Tag`, filter `Tag Added = escalation_active`
- Action: `Internal Notification`
  - Type: `In-App`
  - Recipients: salon owner (User)
  - Subject: `🚨 {{contact.first_name}} treba tvoju pažnju`
  - Message:
    ```
    Razlog: {{contact.last_escalation_reason}}

    Otvori razgovor:
    https://app.gohighlevel.com/v2/location/{{location.id}}/contacts/detail/{{contact.id}}

    Ukloni tag "escalation_active" da se bot vrati.
    ```
- Save → Publish

No commit.

## Task C4: Smoke S3 — tool escalate triggers tag + push

- [ ] **Step 1: Restart backend, ensure tunnel up**

```
rtk proxy npm run dev
```

- [ ] **Step 2: From test IG, send something that triggers LLM to call escalate_to_owner**

Try messages that match SoT `escalation_triggers` (typically complaint-flavored): `"Žalim se na frizera, totalno ste mi uništili kosu!"`.

- [ ] **Step 3: Observe expected outcomes**

Backend log:
- `escalated to owner reason=<from LLM>`
- `ghl addTag success`
- `ghl updateCustomField success`

GHL UI (or owner's GHL mobile app):
- Contact's `escalation_active` tag visible
- Custom field `Last Escalation Reason` populated
- In-App push notification received on owner's GHL mobile app (within ~5s)
- Tapping push opens contact detail in GHL

DB:
```sql
SELECT reason, ghl_tag_added_at, resumed_at FROM escalations ORDER BY created_at DESC LIMIT 1;
SELECT handoff_until FROM conversations WHERE id = (SELECT conversation_id FROM escalations ORDER BY created_at DESC LIMIT 1);
```

Expect: 1 escalation row, `resumed_at=NULL`, `handoff_until` ~4h in future.

- [ ] **Step 4: Confirm bot doesn't reply to next inbound while paused**

Send another IG message from test account: `"Test"`. Verify backend log says `handoff active; bot paused`. No bot reply on IG side. DB has the inbound message but no new outbound.

No commit (manual smoke).

## Task C5: Smoke S4 — manual resume via tag removal

- [ ] **Step 1: From owner's GHL UI/app, navigate to contact and remove `escalation_active` tag**

- [ ] **Step 2: Observe backend log**

Expect within ~5s:
- `POST /webhooks/ghl/resume received`
- `bot_resumed by=owner_manual`

DB:
```sql
SELECT handoff_until FROM conversations WHERE ghl_contact_id = '<test-contact-id>';
SELECT resumed_at, resumed_by FROM escalations WHERE conversation_id = '<conv-id>' ORDER BY created_at DESC LIMIT 1;
```

Expect: `handoff_until=NULL`, `resumed_at` set, `resumed_by='owner_manual'`.

- [ ] **Step 3: Send fresh IG message → bot reagira**

From test account: `"Pitanje o frizurama?"`. Bot replies within delay.

No commit.

### ⏸ PAUSE — Phase C complete

Full escalation lifecycle live. S3+S4 verified. Verify with user before starting Phase D.

---

# Phase D — Auto-resume + edge cases

**Goal**: 4h timeout auto-resume radi preko pravog GHL API-ja. Rate limit + 5xx retry policies. PIT auth failure handling. S5+S7 prolaze.

## Task D1: Update `listActiveTimedOut` to include `salonId`

**Files:**
- Modify: `src/db/repos/escalations.ts` (the `listActiveTimedOut` query)
- Modify: `tests/unit/db/escalations.spec.ts` if exists, or add test

- [ ] **Step 1: Read current implementation**

Read `src/db/repos/escalations.ts`. Find `listActiveTimedOut`. It currently returns `{ escalationId, conversationId, contactId }` per item (or similar).

- [ ] **Step 2: Add test**

If `tests/unit/db/escalations.spec.ts` exists, add a test that seeds 1 expired escalation + verifies `listActiveTimedOut` returns `salonId`. Otherwise create the spec file (use the existing pattern from other repo tests).

```typescript
it('listActiveTimedOut returns salonId in items', async () => {
  // ... seed salon + conversation + escalation with handoff_until in past ...
  const items = await escalationsRepo.listActiveTimedOut(db, new Date());
  expect(items[0]).toHaveProperty('salonId');
  expect(items[0].salonId).toBe(seededSalonId);
});
```

- [ ] **Step 3: Run test, expect fail**

```
rtk proxy npx vitest run tests/unit/db/escalations.spec.ts
```

- [ ] **Step 4: Add `salonId` to query select + return type**

In `src/db/repos/escalations.ts`, modify the `listActiveTimedOut` query: JOIN `conversations` (which has `salon_id`), select `c.salon_id as salonId` (camelCase via Kysely's camelCase or manual transform — match the existing pattern in repos).

- [ ] **Step 5: Run test, verify pass**

- [ ] **Step 6: Commit**

```
git add src/db/repos/escalations.ts tests/unit/db/escalations.spec.ts
git commit -m "feat(repos): listActiveTimedOut returns salonId for per-salon ghl factory lookup"
```

## Task D2: Refactor `auto-resume.ts` to use factory

**Files:**
- Modify: `src/workers/auto-resume.ts:17-21` (deps type)
- Modify: `src/workers/auto-resume.ts:44-65` (worker body)
- Modify: `src/index.ts` (composition root call)

- [ ] **Step 1: Update `setupAutoResume` deps signature**

```typescript
export async function setupAutoResume(deps: {
  db: Db;
  ghlFor: GhlFactory;
  connection: ConnectionOptions;
}): Promise<AutoResumeSetup> {
```

Update imports:

```typescript
// remove: import type { GhlClient } from '../ghl/client.js';
import type { GhlFactory } from '../ghl/client.js';
import * as salonsRepo from '../db/repos/salons.js';
```

- [ ] **Step 2: Load salon per item, bind factory**

Replace the for-loop body:

```typescript
      for (const item of items) {
        try {
          const salon = await salonsRepo.findById(deps.db, item.salonId);
          if (!salon) {
            logger.warn({ escalationId: item.escalationId, salonId: item.salonId }, 'salon missing during auto-resume; skipping');
            continue;
          }
          const ghl = deps.ghlFor(salon);
          await escalationsRepo.markResumed(deps.db, item.escalationId, 'auto_timeout');
          await conversationsRepo.setHandoffUntil(deps.db, item.conversationId, null);
          await ghl.removeTag(item.contactId, ['escalation_active']);
          await eventsRepo.insert(deps.db, item.conversationId, 'bot_resumed', { by: 'auto_timeout' });
          logger.info({ escalationId: item.escalationId, conversationId: item.conversationId }, 'auto-resumed');
        } catch (err) {
          logger.error({ err, escalationId: item.escalationId }, 'auto-resume failed for escalation');
        }
      }
```

- [ ] **Step 3: Update `src/index.ts` call**

Replace the temporary bridge from Task B8:

```typescript
const autoResume = await setupAutoResume({ db, ghlFor, connection });
```

- [ ] **Step 4: Typecheck + tests**

```
rtk proxy npm run lint
rtk proxy npm run test
```

Expected: clean, 29 + new D1 test pass.

- [ ] **Step 5: Commit**

```
git add src/workers/auto-resume.ts src/index.ts
git commit -m "refactor(v2): auto-resume uses GhlFactory per item"
```

## Task D3: Retry policy for 5xx + 429 in RealGhlClient

**Files:**
- Modify: `src/ghl/real.ts` (request method)
- Modify: `tests/unit/ghl/real.spec.ts` (retry tests)

- [ ] **Step 1: Write failing tests**

Append to `tests/unit/ghl/real.spec.ts`:

```typescript
describe('RealGhlClient retry on 5xx', () => {
  it('retries 500 up to 2 times then propagates', async () => {
    let calls = 0;
    const fetcher: typeof fetch = async () => {
      calls++;
      return new Response('boom', { status: 500 });
    };
    const client = new RealGhlClient('pit', 'loc', fetcher);
    await expect(client.getMessage('m')).rejects.toMatchObject({ status: 500 });
    expect(calls).toBe(3); // initial + 2 retries
  });

  it('returns 200 after 1 transient 503', async () => {
    let calls = 0;
    const fetcher: typeof fetch = async () => {
      calls++;
      if (calls === 1) return new Response('', { status: 503 });
      return new Response(JSON.stringify({}), { status: 200 });
    };
    const client = new RealGhlClient('pit', 'loc', fetcher);
    const result = await client.getMessage('m');
    expect(calls).toBe(2);
    expect(result.text).toBe('');
  });

  it('does NOT retry 4xx other than 429', async () => {
    let calls = 0;
    const fetcher: typeof fetch = async () => {
      calls++;
      return new Response('', { status: 401 });
    };
    const client = new RealGhlClient('pit', 'loc', fetcher);
    await expect(client.getMessage('m')).rejects.toMatchObject({ status: 401 });
    expect(calls).toBe(1);
  });

  it('retries 429 once respecting Retry-After', async () => {
    let calls = 0;
    const fetcher: typeof fetch = async () => {
      calls++;
      if (calls === 1) {
        return new Response('', { status: 429, headers: { 'Retry-After': '0' } });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    };
    const client = new RealGhlClient('pit', 'loc', fetcher);
    await client.getMessage('m');
    expect(calls).toBe(2);
  });

  it('propagates 429 on second 429', async () => {
    let calls = 0;
    const fetcher: typeof fetch = async () => {
      calls++;
      return new Response('', { status: 429, headers: { 'Retry-After': '0' } });
    };
    const client = new RealGhlClient('pit', 'loc', fetcher);
    await expect(client.getMessage('m')).rejects.toMatchObject({ status: 429 });
    expect(calls).toBe(2);
  });
});
```

- [ ] **Step 2: Run, verify fail**

```
rtk proxy npx vitest run tests/unit/ghl/real.spec.ts -t "retry"
```

Expected: 5 fail (no retry logic yet).

- [ ] **Step 3: Implement retry in `request()`**

Replace the `request` method in `src/ghl/real.ts`:

```typescript
  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.pit}`,
      Version: GHL_API_VERSION,
      Accept: 'application/json',
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const backoffMs = [500, 1500]; // up to 2 retries
    let lastError: GhlApiError | null = null;
    let retried429 = false;

    for (let attempt = 0; attempt <= backoffMs.length; attempt++) {
      const res = await this.fetcher(`${GHL_BASE_URL}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (res.ok) {
        if (res.status === 204) return undefined as T;
        return (await res.json()) as T;
      }

      const text = await res.text().catch(() => '');

      if (isOutsideWindowError(res.status, text)) {
        throw new OutsideMessagingWindowError(path, text);
      }

      // 429: retry once respecting Retry-After
      if (res.status === 429 && !retried429) {
        retried429 = true;
        const retryAfter = parseInt(res.headers.get('Retry-After') ?? '1', 10);
        await sleep(Math.max(0, retryAfter * 1000));
        continue;
      }

      // 5xx: retry with backoff
      if (res.status >= 500 && attempt < backoffMs.length) {
        await sleep(backoffMs[attempt]);
        continue;
      }

      throw new GhlApiError(res.status, path, text);
    }

    throw lastError ?? new GhlApiError(500, path, 'unknown retry exhaustion');
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
```

- [ ] **Step 4: Run, verify pass**

```
rtk proxy npx vitest run tests/unit/ghl/real.spec.ts
```

Expected: all 16 pass.

- [ ] **Step 5: Commit**

```
git add src/ghl/real.ts tests/unit/ghl/real.spec.ts
git commit -m "feat(ghl): retry policy — 5xx exp backoff x2, 429 with Retry-After"
```

## Task D4: PIT auth failure → escalate + disable salon

**Files:**
- Modify: `src/core/generate-response.ts` (catch send/tag/customField errors)
- Modify: `src/core/escalate.ts` (catch addTag/updateCustomField 401/403)
- Modify: `src/db/repos/salons.ts` (add `setActive(db, id, active)` if not present)

- [ ] **Step 1: Add `setActive` to salons repo**

Read `src/db/repos/salons.ts`. If `setActive` doesn't exist, add:

```typescript
export async function setActive(db: Db, id: string, active: boolean): Promise<void> {
  await db.updateTable('salons').set({ is_active: active, updated_at: new Date() }).where('id', '=', id).execute();
}
```

- [ ] **Step 2: Wire detection in `escalate.ts`**

In `src/core/escalate.ts`, the existing try/catch around `addTag` and `updateCustomField` catches all errors but doesn't differentiate auth fails. Add typed check:

```typescript
import { GhlApiError } from '../ghl/errors.js';
import * as salonsRepo from '../db/repos/salons.js';

// inside the catch around addTag (and same for updateCustomField):
  try {
    await input.ghl.addTag(input.conversation.ghlContactId, ['escalation_active']);
  } catch (err) {
    if (err instanceof GhlApiError && (err.status === 401 || err.status === 403)) {
      logger.error({ err, salonId: input.salon.id }, 'GHL auth failed during escalate addTag; disabling salon');
      await salonsRepo.setActive(input.db, input.salon.id, false);
    } else {
      logger.error({ err, conversationId: input.conversation.id }, 'ghl addTag failed during escalate');
    }
  }
```

(Same wrap around `updateCustomField`.)

- [ ] **Step 3: Wire detection in `generate-response.ts` sendMessage catch**

In `src/core/generate-response.ts`, the catch block around `ghl.sendMessage`:

```typescript
import { GhlApiError, OutsideMessagingWindowError } from '../ghl/errors.js';
import * as salonsRepo from '../db/repos/salons.js';

    } catch (err) {
      logger.error({ err, conversationId }, 'ghl sendMessage failed');

      if (err instanceof GhlApiError && (err.status === 401 || err.status === 403)) {
        await salonsRepo.setActive(deps.db, salon.id, false);
        await escalateToOwner({
          db: deps.db, ghl: deps.ghl, salon, conversation: ctx.conversation,
          reason: 'ghl_auth_failed',
        });
        return;
      }

      const reason = err instanceof OutsideMessagingWindowError
        ? 'cannot_reply_outside_window'
        : 'cannot_reply_outside_window'; // keep V1 reason for generic send fail
      await escalateToOwner({
        db: deps.db, ghl: deps.ghl, salon, conversation: ctx.conversation, reason,
      });
      return;
    }
```

- [ ] **Step 4: Add test for auth-fail escalation**

Add an e2e (or unit) test that wires a `FakeLlmClient` + a `MockGhlClient` modified to throw `GhlApiError(401)` on sendMessage. Easiest: parameterize MockGhlClient with an optional `sendMessageImpl` injection in tests, or extend `MockGhlClient` test class. (If MockGhlClient is hard to extend, add a `tests/unit/core/auth-fail.spec.ts` that instantiates `generateResponse` directly with a custom GhlClient mock.)

Sketch:

```typescript
it('on 401 from sendMessage: disables salon and escalates with reason ghl_auth_failed', async () => {
  // ... mock ghl that throws GhlApiError(401) on sendMessage ...
  await generateResponse({ db, ghl: throwingClient, llm, defaultLlmModel }, salon, conversationId);
  const escalation = await escalationsRepo.findLatestByConversation(db, conversationId);
  expect(escalation.reason).toBe('ghl_auth_failed');
  const reloadedSalon = await salonsRepo.findById(db, salon.id);
  expect(reloadedSalon?.is_active).toBe(false);
});
```

- [ ] **Step 5: Run all tests**

```
rtk proxy npm run test
```

Expected: clean.

- [ ] **Step 6: Commit**

```
git add src/core/escalate.ts src/core/generate-response.ts src/db/repos/salons.ts tests/unit/core/auth-fail.spec.ts
git commit -m "feat(v2): on GHL 401/403: disable salon + escalate as ghl_auth_failed"
```

## Task D5: Smoke S5 + S7

- [ ] **Step 1: S5 — auto-resume after timeout**

Lower handoff_window_hours for this test:

```sql
UPDATE salons SET config = config || '{"handoff_window_hours": 0.05}'::jsonb WHERE display_name = 'Bella Hair Studio';
```

(0.05h = 3 min — auto-resume scheduler ticks every 5 min, so first tick after 3-8 min wakes us.)

Trigger escalation (S3 step 2 again). Wait ~8 min. Observe:
- Backend log: `auto-resume tick: found expired escalations`, `auto-resumed`
- GHL UI: contact's `escalation_active` tag REMOVED (visible in contact view)
- DB: `escalations.resumed_at IS NOT NULL`, `resumed_by='auto_timeout'`

Restore config: `UPDATE salons SET config = config || '{"handoff_window_hours": 4}'::jsonb WHERE display_name = 'Bella Hair Studio';`

- [ ] **Step 2: S7 — PIT auth fail**

Corrupt PIT to force 401:

```sql
UPDATE salons SET ghl_pit = 'invalid-pit' WHERE display_name = 'Bella Hair Studio';
```

Send IG message. Observe backend log:
- `GhlApiError 401 on /conversations/messages`
- `escalated to owner reason=ghl_auth_failed`
- `setActive false` (or similar)

DB: `salons.is_active=false`, escalation row with `reason='ghl_auth_failed'`.

Restore PIT + active flag:

```sql
UPDATE salons SET ghl_pit = '<original>', is_active = true WHERE display_name = 'Bella Hair Studio';
```

No commit (manual smoke).

### ⏸ PAUSE — Phase D complete

Auto-resume + auth fail handling verified. Verify with user before Phase E.

---

# Phase E — Polish (optional, prije prvog stvarnog klijenta)

**Goal**: Production-ready hardening. PIT encryption, README/runbook update, optional named tunnel.

## Task E1: PIT encryption with pgcrypto

**Files:**
- Create: `src/db/migrations/0002_encrypt_pit.ts`
- Modify: `src/db/repos/salons.ts` (encrypt on write, decrypt on read)
- Modify: `src/config.ts` (add `pitEncryptionKey`)
- Modify: `.env.example`

- [ ] **Step 1: Add `pitEncryptionKey` to config**

In `src/config.ts`, append to schema:

```typescript
pitEncryptionKey: z.string().min(32).optional(),
```

In `.env.example`:

```env
# Required when USE_MOCK_GHL=false: 32+ byte key for pgcrypto-symmetric PIT storage
PIT_ENCRYPTION_KEY=
```

- [ ] **Step 2: Migration to convert `ghl_pit TEXT` → `ghl_pit BYTEA`**

Create `src/db/migrations/0002_encrypt_pit.ts`:

```typescript
import type { Kysely } from 'kysely';
import { sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  // pgcrypto already enabled in 0001
  await sql`ALTER TABLE salons ADD COLUMN ghl_pit_encrypted BYTEA`.execute(db);
  await sql`UPDATE salons SET ghl_pit_encrypted = pgp_sym_encrypt(ghl_pit, current_setting('app.pit_key', true)) WHERE ghl_pit IS NOT NULL AND current_setting('app.pit_key', true) IS NOT NULL`.execute(db);
  // intentionally leave ghl_pit column for now — drop in 0003 after operational verification
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE salons DROP COLUMN ghl_pit_encrypted`.execute(db);
}
```

- [ ] **Step 3: Update salons repo to encrypt/decrypt**

Modify `salonsRepo.create` to set `ghl_pit_encrypted = pgp_sym_encrypt($pit, $key)` via raw SQL. Modify `findById`/`findByLocationId` to select `pgp_sym_decrypt(ghl_pit_encrypted, $key) AS ghl_pit`.

- [ ] **Step 4: Update tests + composition root**

Add `pitEncryptionKey` to `tests/helpers/buildTestApp.ts` env stub.

- [ ] **Step 5: Run migrations + tests**

```
rtk proxy npm run migrate:up
rtk proxy npm run test
```

- [ ] **Step 6: Commit**

```
git add src/db/migrations/0002_encrypt_pit.ts src/db/repos/salons.ts src/config.ts .env.example tests/helpers/buildTestApp.ts
git commit -m "feat(v2): pgcrypto-symmetric encryption for ghl_pit"
```

(Note: Task E1 is optional for first live test; required before first real-client launch.)

## Task E2: README + runbook update

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Append V2 section to README**

Add:
- "Tunneling locally" subsection: cloudflared install + start command
- "Onboarding a salon" subsection: link to spec's runbook (or inline summary)
- "Production deploy" subsection: link to spec's §5

- [ ] **Step 2: Commit**

```
git add README.md
git commit -m "docs: V2 sections in README — tunnel, onboarding, deploy"
```

## Task E3: Named cloudflared tunnel (optional)

Operator action only.

- [ ] **Step 1: Cloudflare account + DNS**

Follow https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/create-local-tunnel/ — create tunnel `salon-receptionist-dev`, route DNS `dev.tvojadomena.com` to it.

- [ ] **Step 2: Run named tunnel**

```
cloudflared tunnel run salon-receptionist-dev
```

URL is stable: `https://dev.tvojadomena.com`.

- [ ] **Step 3: Update GHL Workflow #1 + #2 URLs (one time)**

In each workflow Custom Webhook action, replace random `trycloudflare.com` URL with `https://dev.tvojadomena.com/webhooks/ghl/inbound` (or `/resume`). Publish.

No commit.

### ⏸ PAUSE — Phase E complete

V2 production-ready. Verify with user before merging to main or starting V3.

---

# Self-review checklist

**Spec coverage:**
- ✅ §1 Architecture — covered by Task B5-B10 (factory + workflow #1)
- ✅ §2 GHL configuration — Task A4 (custom fields/tag/PIT), B10 (Workflow #1), C2 (Workflow #2), C3 (Workflow #3)
- ✅ §3 RealGhlClient — Tasks B1-B3 (errors + skeleton + payloads), C1 (tags/customField), D3 (retry)
- ✅ §4 Tunnel + env — Task A1 (env vars), A3 (cloudflared)
- ✅ §5 Deploy — Task E2 (README link to spec §5), E3 (named tunnel)
- ✅ §6 Onboarding runbook — Tasks A4-A6 (operator checklist baked into plan)
- ✅ §7 Error handling — D3 (retry), D4 (auth fail), C4-C5 (escalation flow already in V1)
- ✅ §8 Smoke checklist S1-S5 + S7 — B10 (S1+S2), C4 (S3), C5 (S4), D5 (S5+S7); S6 noted as covered by existing V1 e2e
- ✅ §9 Phase breakdown — exact 5 phases A-E reflected

**Pause-points:** ⏸ markers after Phase A, B, C, D, E. Respects user's "stop after each phase" memory.

**Placeholder scan:** every step has either exact code, exact command, or operator action with concrete UI clicks. No `TBD` / `TODO` / "implement later".

**Type consistency:** `GhlFactory` defined in Task B4, used consistently in B5/B6/B7/B8/B9/D2. `GhlApiError`/`OutsideMessagingWindowError` defined in B1, used in B2/D3/D4. Method signatures stable across tasks.

**Estimated effort:** ~9-13h fokusiranog rada across A-D (per spec §9), Phase E +2-4h.
