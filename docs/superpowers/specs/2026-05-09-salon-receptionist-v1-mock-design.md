# AI Salon Receptionist — V1 Mock Phase Design

**Status**: Approved (brainstorming output)
**Date**: 2026-05-09
**Owner**: Ivan
**Predecessor**: `AI_Salon_Receptionist_V1_Hybrid_Spec.pdf` (input technical specification)
**Scope**: V1 mock fazu (T1-T3 spec timeline) — kompletna conversation logika "in vitro" s `MockGhlClient`. Real GHL connect je odvojena, kasnija faza.

---

## 0. Context

Ovo je dizajn dokument za prvu implementacijsku fazu hibridne arhitekture iz base spec-a. Korisnik je u brainstorming sesiji izabrao "Fundament bez GHL" opseg, pa ovaj design fokusira na to kako izgraditi cijelu conversation logiku, sanitizer, persistencu, job queue i escalation flow — uz `MockGhlClient` koji simulira sve outbound pozive prema GHL-u kao zapise u Postgres bazi i pino logu.

Real GHL HTTP integracija (zamjena `MockGhlClient` → `RealGhlClient`) je predviđena kao odvojen, manji posao u kasnijoj fazi (T3-T4 base spec timeline). Dizajn interface-a je takav da je ta zamjena literalno jedna linija u composition root-u.

### 0.1 Korekcije base spec-a iz GHL web research-a

Web research provedeno 2026-05-09 otkrilo je tri stavke koje treba ispraviti u odnosu na base spec, ali **nijedna ne mijenja arhitekturu mock faze**:

1. **"Location-level API key" → "Private Integration Token (PIT)"**. GHL je u 2026 deprecirao legacy V1 API key. PIT ima identičan auth pattern (`Authorization: Bearer <pit>` + `Version: 2021-04-15`). Uticaj: kolona u DB-u zove se `salons.ghl_pit`, runbook upućuje na Settings → Private Integrations.
2. **"Send Mobile App Push Notification" → "Internal Notification" workflow action**. Generička push akcija s custom deep-link na Conversations view ne postoji u GHL-u. Internal Notification s "In-App" channelom isporučuje push na vlasnikov GHL mobile app. Uticaj samo na runbook za GHL onboarding (Faza A korak A5), ne na backend kod.
3. **`GhlClient.getMessage(messageId)` fallback potreban**. Workflow Webhook action možda ne nosi tekst inbound IG poruke u merge tag-ovima. Backend mora moći fall-back-ati na `GET /conversations/messages/{id}` ako payload ne sadrži text. Uticaj: jedna dodatna metoda u `GhlClient` interface-u; mock je in-memory mapa.

### 0.2 Decisions table (iz brainstorming-a)

| Decision | Value |
|---|---|
| V1 mock scope | "Fundament bez GHL" — sve iz spec T1-T3 osim vision/voice |
| Dev test loop | HTTP/curl simulator (`/dev/simulate-inbound` endpoint) |
| Repo struktura | Single package, single process — jedan `src/` tree, api+worker u istom procesu |
| Test scope | Sanitizer 100% + property-based; 5 golden e2e protiv prave Postgres + FakeLlmClient + MockGhlClient |
| LLM u dev-u | Uvijek real (Anthropic SDK); FakeLlmClient samo za testove |
| DB layer | Kysely (typed SQL builder) |
| Phase approach | B — Vertikalna kriška: skeleton end-to-end u T1, postupna zamjena stubova |

---

## 1. Module structure

```
salon-receptionist/
├── src/
│   ├── index.ts                       # entry: starta Fastify + BullMQ worker u istom procesu
│   ├── config.ts                      # env loading + zod validacija
│   ├── routes/
│   │   ├── webhooks-ghl-inbound.ts    # POST /webhooks/ghl/inbound
│   │   ├── webhooks-ghl-resume.ts     # POST /webhooks/ghl/resume
│   │   ├── dev-simulate.ts            # POST /dev/simulate-inbound (DEV only)
│   │   └── admin-salons.ts            # POST /admin/salons
│   ├── workers/
│   │   ├── respond.ts                 # BullMQ job: load → prompt → LLM → sanitize → send
│   │   └── auto-resume.ts             # recurring: resume escalations past handoff_until
│   ├── core/
│   │   ├── handle-inbound.ts          # webhook handler logic: persist + schedule (s coalescing)
│   │   ├── generate-response.ts       # worker logic (čista funkcija orkestracije)
│   │   ├── escalate.ts                # escalation tool handler
│   │   └── types.ts                   # Salon, Conversation, Message, Event domain types
│   ├── sanitizer/                     # PURE — bez I/O
│   │   ├── index.ts                   # sanitize(raw, ctx) -> { messages, modifications }
│   │   └── split.ts                   # sentence boundary splitter
│   ├── prompt/                        # PURE — bez I/O
│   │   ├── build.ts                   # system prompt + SoT injection + history
│   │   └── tools.ts                   # tool schema definicije
│   ├── llm/
│   │   └── client.ts                  # AnthropicLlmClient (real)
│   ├── ghl/
│   │   ├── client.ts                  # GhlClient interface
│   │   └── mock.ts                    # MockGhlClient (loga + persist u DB)
│   ├── db/
│   │   ├── kysely.ts                  # connection
│   │   ├── schema.ts                  # Kysely typed table interfaces
│   │   ├── migrations/                # SQL .up/.down
│   │   └── repos/                     # po jedan file po agregatu
│   │       ├── salons.ts
│   │       ├── conversations.ts
│   │       ├── messages.ts
│   │       ├── events.ts
│   │       └── escalations.ts
│   ├── queue/
│   │   └── index.ts                   # BullMQ setup
│   └── lib/
│       ├── logger.ts                  # pino
│       └── errors.ts                  # SanitizerEmptyOutputError, itd.
├── tests/
│   ├── unit/                          # sanitizer (property-based + snapshot), prompt, helpers
│   └── e2e/                           # 5 golden paths protiv prave Postgres
│       └── fixtures/
│           └── salon-bella.json       # sample SoT
├── docker-compose.yml                 # postgres 15 + redis 7
├── package.json
├── tsconfig.json
├── .env.example
└── README.md
```

### 1.1 Princip ovisnosti

- `sanitizer/` i `prompt/` su **pure** — ne uvoze db, llm, ghl, queue. Sve što trebaju primaju kao argumente.
- `db/`, `llm/`, `ghl/`, `queue/` su **side-effectful** — wrap-aju vanjski svijet.
- `core/` je **orkestrator** — uvozi i pure i side-effectful module, slaže ih u use-case funkcije.
- `routes/` i `workers/` su **tanki ulazi** — primaju HTTP/job event, validiraju, delegiraju u `core/`.
- `tests/` koriste pravu Postgres + Redis (test profil docker-compose); samo `LlmClient` i `GhlClient` se zamjenjuju (FakeLlmClient, MockGhlClient).

### 1.2 Dependency lista

`fastify`, `@anthropic-ai/sdk`, `bullmq`, `ioredis`, `pg`, `kysely`, `kysely-codegen` (dev), `pino`, `pino-pretty` (dev), `zod`, `vitest`, `fast-check`. Ostale stavke iz base spec-a (`OpenAI Whisper`, `Sentry`, `Better Stack`) nisu u V1 mock fazi.

---

## 2. Boundary interfaces (the seams)

Princip: **interface samo na vanjskim granicama** (HTTP prema GHL, HTTP prema Anthropic). Repos su typed funkcije koje primaju `db` instancu — testovi koriste pravu test bazu.

### 2.1 `GhlClient`

```typescript
// src/ghl/client.ts
export interface GhlClient {
  sendMessage(input: {
    contactId: string;
    type: 'IG';
    message: string;
  }): Promise<{ ghlMessageId: string }>;

  // Fallback za slučaj da workflow webhook payload ne sadrži tekst
  getMessage(messageId: string): Promise<{
    text: string;
    attachments: Array<{ url: string; type: 'image' | 'audio' | 'video' }>;
  }>;

  addTag(contactId: string, tags: string[]): Promise<void>;
  removeTag(contactId: string, tags: string[]): Promise<void>;

  updateCustomField(input: {
    contactId: string;
    fieldId: string;
    value: string | number | boolean;
  }): Promise<void>;
}
```

`MockGhlClient` (V1):
- `sendMessage` → INSERT u `mock_outbound_log` (`{ id, salon_id, contact_id, type, message, sent_at }`) + pino log
- `getMessage` → in-memory `Map<messageId, { text, attachments }>` koju popunjava `/dev/simulate-inbound` route u "fetch fallback" scenariju
- `addTag`/`removeTag`/`updateCustomField` → upsert u `mock_contact_state` (`{ contact_id, tags jsonb, custom_fields jsonb }`)

`RealGhlClient` (kasnija faza, izvan ovog spec-a): `fetch` na `services.leadconnectorhq.com` s `Bearer <pit>` + `Version: 2021-04-15`, retry s exp backoff na 5xx i 429, **graciozno handla 24h-window send error** (loga, NE retry-a, vraća tipiziran error).

### 2.2 `LlmClient`

Iako dev koristi real Anthropic SDK, interface postoji radi testova (golden e2e ne smiju trošiti tokene niti biti flaky).

```typescript
// src/llm/client.ts
export interface LlmClient {
  complete(input: {
    systemPrompt: string;
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;
    tools: ToolDefinition[];
    model: string;
    maxTokens: number;
  }): Promise<{
    text: string;
    toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>;
    usage: { inputTokens: number; outputTokens: number };
  }>;
}
```

- `AnthropicLlmClient` — wrapper oko `@anthropic-ai/sdk`, timeout 30s, retry max 2 na 5xx
- `FakeLlmClient` (samo `tests/`) — `stage(when, then)` helper za deterministic mappings input → output

### 2.3 Repos kao funkcije

```typescript
// src/db/repos/conversations.ts
export async function findOrCreate(
  db: Kysely<Database>,
  salonId: string,
  ghlContactId: string,
  clientHandle: string | null
): Promise<Conversation>;

export async function setHandoffUntil(
  db: Kysely<Database>,
  id: string,
  until: Date | null
): Promise<void>;

export async function loadContext(
  db: Kysely<Database>,
  conversationId: string,
  recentMessageLimit: number
): Promise<ConversationContext>;

export async function mergeState(
  db: Kysely<Database>,
  id: string,
  patch: Record<string, unknown>
): Promise<void>;
```

Slično za `salons`, `messages`, `events`, `escalations`. Primaju `db` ili `tx` (transaction) kao prvi parametar.

### 2.4 Composition root

```typescript
// src/index.ts
const cfg = loadConfig();
const db = createKyselyDb(cfg.databaseUrl);
const redis = new Redis(cfg.redisUrl);
const llm: LlmClient = new AnthropicLlmClient(cfg.anthropicApiKey);
const ghl: GhlClient = new MockGhlClient(db);  // V1; later: new RealGhlClient(...)
const queue = createQueue(redis);

const app = buildServer({ db, queue, ghl, llm, cfg });
const worker = buildWorker({ db, queue, ghl, llm, cfg });

await Promise.all([app.listen({ port: cfg.port }), worker.start()]);
```

Switch na real GHL u kasnijoj fazi: jedna linija.

### 2.5 Što NIJE iza interface-a

- **Postgres** — repos su čiste funkcije, testovi koriste pravu test bazu
- **Redis/BullMQ** — testovi protiv prave instance kroz docker-compose test profil
- **Pino logger** — globalan singleton
- **Konfig** — zod-validated objekt, primamo kao parametar

---

## 3. Data flow & concurrency

### 3.1 Inbound flow

```
[curl POST /dev/simulate-inbound]    ← V1 dev primarno
[GHL workflow → POST /webhooks/ghl/inbound]    ← real, kasnije
            │
            ▼  routes/webhooks-ghl-inbound.ts
     ┌──────────────────────────┐
     │ verify X-Webhook-Secret  │
     │ schema-validate (zod)    │
     │ reply 200 OK ODMAH       │
     │ then await handleInbound │
     └──────────────────────────┘
            │
            ▼  core/handle-inbound.ts
     ┌──────────────────────────────────────────┐
     │ 1. lookup salon by ghl_location_id       │
     │    (in-memory cache, 5 min TTL)          │
     │ 2. resolve message text:                 │
     │    if payload.message_text → use it      │
     │    else → ghl.getMessage(messageId)      │
     │ 3. findOrCreate conversation             │
     │ 4. idempotency: skip if ghl_message_id   │
     │    već u messages (UNIQUE indeks)        │
     │ 5. INSERT messages (direction='inbound') │
     │ 6. UPDATE conversations.last_message_at  │
     │ 7. ako handoff_until > now() → return    │
     │    (bot pauziran, ne planiraj posao)     │
     │ 8. queue.remove(jobId).catch(()=>{})     │
     │ 9. queue.add('respond', { conversationId,│
     │    salonId },                            │
     │    { jobId: `respond:${convId}`,         │
     │      delay: salon.config.responseDelayMs │
     │    })                                    │
     └──────────────────────────────────────────┘
            │
            ▼  [BullMQ čeka delay, pa daje jobId workeru]
            ▼  workers/respond.ts → core/generate-response.ts
     ┌──────────────────────────────────────────┐
     │ 1. SET NX EX 60 conversation:{id}:lock   │
     │    (drugi worker → drop, vraća se)       │
     │ 2. RECHECK handoff_until — možda je      │
     │    eskaliran tijekom delay prozora       │
     │ 3. load: salon (sa SoT), conv, last 15   │
     │    messages, recent events               │
     │ 4. prompt = build(...)                   │
     │ 5. result = llm.complete(prompt, tools)  │
     │ 6. process tool calls (escalate?         │
     │    mark_link_sent? set_state_flag?)      │
     │ 7. if escalated → release lock, return   │
     │    (nema sanitize, nema send)            │
     │ 8. sanitized = sanitize(result.text,ctx) │
     │    if SanitizerEmptyOutputError →        │
     │       escalate + return                  │
     │ 9. za svaku outbound poruku:             │
     │    ghl.sendMessage(...)                  │
     │    INSERT messages (direction='outbound',│
     │      ai_raw_output, sanitize_mods,       │
     │      tokens, cost, ghl_message_id)       │
     │ 10. ako finalni output ima booking link  │
     │     i events nema 'booking_link_sent'    │
     │     ovog turn-a → INSERT event           │
     │ 11. release lock                         │
     └──────────────────────────────────────────┘
```

### 3.2 Coalescing burst poruka

Cilj: "klijent piše 3 poruke za 5s → worker pokreni SAMO JEDNOM, ~delay sekundi nakon ZADNJE poruke, s pristupom svim 3 porukama".

Implementacija:
1. Inbound poruka uvijek ide u DB *prije* schedulanja job-a. Worker pri izvršenju čita zadnjih 15 messages, pa automatski pokupi sve nove.
2. Job ima fixed `jobId: respond:${conversationId}`. Da postignemo "rolling delay" gdje svaka nova poruka resetira timer:
   ```typescript
   await queue.remove(jobId).catch(() => {}); // makni pending ako postoji
   await queue.add('respond', payload, { jobId, delay });
   ```
3. Redis distributed lock je defense-in-depth za edge case kad worker već "active" pa stigne sljedeća poruka — drugi worker run čeka prvog ili dropa.

### 3.3 Resume flow

**Manual** (vlasnik makne tag u GHL UI → workflow #3 → backend):
```
POST /webhooks/ghl/resume { location_id, contact_id }
  → verify secret + 200 OK
  → lookup salon + conversation
  → UPDATE conversations.handoff_until = NULL
  → UPDATE escalations SET resumed_at, resumed_by='owner_manual' WHERE active
  → INSERT events ('bot_resumed')
```

**Auto** (4h timeout — `workers/auto-resume.ts`, BullMQ recurring every 5 min):
```
SELECT e.* FROM escalations e
JOIN conversations c ON c.id = e.conversation_id
WHERE e.resumed_at IS NULL
  AND c.handoff_until < now()

For each:
  UPDATE escalations SET resumed_at, resumed_by='auto_timeout'
  UPDATE conversations.handoff_until = NULL
  ghl.removeTag(contact_id, ['escalation_active'])
  INSERT events ('bot_resumed')
```

### 3.4 Failure modes

| Scenarij | Reakcija |
|---|---|
| Webhook secret mismatch | 401, log warning, drop |
| Salon ne postoji ili `is_active=false` | 200 OK (ne želimo GHL retry), log info, drop |
| Idempotent duplicate (`ghl_message_id` već u DB) | 200 OK, log debug, drop |
| LLM 5xx ili timeout | retry s exp backoff, max 2; ako i dalje fail → escalate (`reason='llm_failed'`) |
| `SanitizerEmptyOutputError` | escalate (`reason='sanitizer_empty_output'`) |
| `GhlClient.sendMessage` fail (24h window u real fazi; mock ne fail-a) | persist outbound s flag, ne retry, escalate (`reason='cannot_reply_outside_window'`) |
| Worker exception | BullMQ retry max 3 s exp backoff; nakon toga DLQ |
| Lock acquisition fail | log debug, return — drugi worker ima |

---

## 4. Sanitizer + Tools + State + SoT

### 4.1 Sanitizer

Pipeline iz base spec sekcije 5.1 ostaje 1:1: forbidden char scrub → link cap & dedup → emoji cap → word count split (max 2 messages, max 40 words each) → trim → empty check throw.

V1 detalji:
- **Pure modul** — bez DB pristupa. `SanitizeContext` prima `bookingLinkSentInLastN: (n: number) => Promise<boolean>` kao closure. Worker konstruira closure nad već učitanim `recentEvents` iz DB konteksta — sanitizer ne radi nove DB pozive.
- **Test corpus** u `tests/unit/sanitizer/fixtures/` kao parovi `<name>.input.txt` + `<name>.expected.json`.
- **Property invariante** (fast-check, 10K iteracija):
  - `messages.length ≤ 2`
  - `each msg.split(/\s+/).length ≤ 40`
  - `no '—' '–' '…' ';' u outputu`
  - `each msg has ≤ 1 occurrence of /https?:\/\//`
  - `each msg has ≤ 2 emoji codepoints`
  - `messages array nikad prazan bez throw-a`
- **Regression korpus**: dodaj failure case kao novi fixture čim se pojavi.

### 4.2 Tool handlers

Tri toola iz base spec sekcije 8:

**`escalate_to_owner(reason, context_summary?)`**
```typescript
// src/core/escalate.ts
export async function escalateToOwner(args: {
  db: Kysely<Database>;
  ghl: GhlClient;
  salon: Salon;
  conversation: Conversation;
  reason: string;
  contextSummary?: string;
}): Promise<void> {
  const handoffUntil = new Date(Date.now() + salon.config.handoffWindowHours * 3600_000);

  await db.transaction().execute(async (tx) => {
    await escalationsRepo.upsertActive(tx, conversation.id, reason, args.contextSummary);
    await conversationsRepo.setHandoffUntil(tx, conversation.id, handoffUntil);
    await eventsRepo.insert(tx, conversation.id, 'escalated_to_owner', { reason });
  });

  // GHL pozivi outside transaction (mreža + idempotent)
  await ghl.addTag(conversation.ghlContactId, ['escalation_active']);
  await ghl.updateCustomField({
    contactId: conversation.ghlContactId,
    fieldId: salon.ghlCustomFieldIds.lastEscalationReason,
    value: reason,
  });
}
```

**`mark_link_sent()`**
```typescript
export async function markLinkSent(db, conversationId): Promise<void> {
  await eventsRepo.insert(db, conversationId, 'booking_link_sent', {});
}
```

**`set_state_flag(key, value)`** s whitelistom:
```typescript
const ALLOWED_STATE_KEYS = ['client_is_hesitant', 'last_quoted_service'] as const;

export async function setStateFlag(db, conversationId, key: string, value: unknown): Promise<void> {
  if (!ALLOWED_STATE_KEYS.includes(key as typeof ALLOWED_STATE_KEYS[number])) {
    logger.warn({ conversationId, key }, 'rejected unknown state flag');
    return;
  }
  await conversationsRepo.mergeState(db, conversationId, { [key]: value });
}
```

**Defense in depth za booking link event**: čak i ako LLM zaboravi pozvati `mark_link_sent`, post-sanitize scan u workeru provjerava: ako finalni outbound message sadrži `salon.booking_link` i još nije inserean event za ovaj turn → INSERT.

### 4.3 Escalation triggers (sve putanje)

Svako mjesto poziva `escalateToOwner()`. Reason je tipiziran string:

| Trigger | Mjesto u kodu | Reason |
|---|---|---|
| LLM tool call `escalate_to_owner` | `core/generate-response.ts` (tool dispatch) | što LLM proslijedi |
| Sanitizer empty output | `core/generate-response.ts` (catch) | `'sanitizer_empty_output'` |
| 3x LLM fail | `core/generate-response.ts` (retry catch) | `'llm_failed'` |
| GHL sendMessage 24h-window error | `core/generate-response.ts` (send catch) | `'cannot_reply_outside_window'` |

Auto-resume scheduler i manual-resume webhook su jedini načini izlaska iz handoff stanja.

### 4.4 State i events

- `conversations.state JSONB` — sadrži samo whitelisted ključeve iz `set_state_flag`. V1 dva ključa.
- `conversations.handoff_until TIMESTAMPTZ` — single source of truth o pauzi. NULL = aktivan.
- `conversation_events` — append-only. V1 koristi tipove: `booking_link_sent`, `escalated_to_owner`, `bot_resumed`.

V2 tipovi (defer): `photo_received`, `voice_note_received`, `price_quoted`, `owner_replied`.

### 4.5 Salon config schema

Base spec sekcija 3.1 spominje `salons.config JSONB` ali ne dokumentira shape. Definiramo eksplicitno za V1:

```typescript
// stored as snake_case JSONB; repos transform to camelCase before returning
export const SalonConfigSchema = z.object({
  response_delay_ms: z.number().int().positive().default(40_000),
  llm_model: z.string().default('claude-sonnet-4-5'),
  handoff_window_hours: z.number().int().positive().default(4),
  booking_link_dedup_window: z.number().int().positive().default(3),
  max_words_per_message: z.number().int().positive().default(40),
  max_emojis: z.number().int().nonnegative().default(2),
  ghl_custom_field_ids: z.object({
    needs_owner_attention: z.string(),
    bot_paused_until: z.string(),
    last_escalation_reason: z.string(),
  }),
});
```

`ghl_custom_field_ids` se popunjava prilikom onboarding-a salon-a (`POST /admin/salons` body sadrži field ID-eve koje je operater iščitao iz GHL UI-a). U mock fazi mogu biti bilo koji string-ovi (samo se moraju match-ati u `mock_contact_state` ispitivanju u testovima).

### 4.6 Naming convention

- **DB JSONB fields**: snake_case (kompatibilno s base spec primjerima i SoT JSON-om koji daje vlasnik salona).
- **TypeScript domain types** (Salon, Conversation, …): camelCase. Repos rade transformaciju snake → camel pri čitanju, camel → snake pri pisanju (Kysely plugin ili eksplicitno u repo funkcijama — odluka u Koraku 3 implementacije).
- **SoT JSON je iznimka**: ostaje snake_case kroz cijeli stack jer je vlasnik-controlled i ne smijemo lomiti njegov format. `salon.sourceOfTruth.salon.booking_link`.
- **Tool argumenti (Anthropic schema)**: snake_case (Anthropic konvencija).

### 4.7 Source of Truth — Zod schema

```typescript
// src/core/sot-schema.ts
import { z } from 'zod';

export const SotSchema = z.object({
  salon: z.object({
    name: z.string(),
    owner_first_name: z.string(),
    location: z.string(),
    timezone: z.string(),
    hours: z.record(z.string(), z.string()),
    booking_link: z.string().url(),
    phone: z.string().optional(),
  }),
  stylists: z.array(z.object({
    name: z.string(),
    specialties: z.array(z.string()),
  })),
  services: z.array(z.object({
    name: z.string(),
    price_range: z.object({
      min: z.number(),
      max: z.number(),
      currency: z.string(),
    }).optional(),
    duration_minutes: z.number().optional(),
    requires_consultation: z.boolean().default(false),
    notes: z.string().optional(),
  })),
  policies: z.object({
    cancellation: z.string().optional(),
    deposit: z.string().optional(),
    price_quote_policy: z.string().optional(),
  }).default({}),
  voice: z.object({
    tone_notes: z.string(),
    signature_phrases: z.array(z.string()).default([]),
    avoid: z.array(z.string()).default([]),
  }),
  escalation_triggers: z.array(z.string()).default([]),
  faqs: z.array(z.object({ q: z.string(), a: z.string() })).default([]),
});

export type Sot = z.infer<typeof SotSchema>;
```

`POST /admin/salons` validira tijelo s `SotSchema.parse(body.source_of_truth)` — invalid SoT je 400 s human-readable error.

Fixture `tests/e2e/fixtures/salon-bella.json` — fiktivni "Bella Hair Studio" salon koji koriste svi golden e2e testovi i početni dev seed.

---

## 5. Testing strategy

### 5.1 Test piramida

```
         ┌─────────────────────────────────┐
         │   Manual smoke (curl)           │  dev driver
         ├─────────────────────────────────┤
         │   5 golden e2e tests            │  prava Postgres + Redis,
         │                                 │  FakeLlmClient + MockGhlClient
         ├─────────────────────────────────┤
         │   Unit: prompt builder          │
         │   Unit: tool handlers           │  in-memory pure logika +
         │   Unit: escalate transactional  │  prava DB s rollback
         ├─────────────────────────────────┤
         │   Sanitizer:                    │
         │   - snapshot fixtures (~30)     │
         │   - property-based (10K iter)   │  najgušći coverage
         └─────────────────────────────────┘
```

### 5.2 Pet golden e2e scenarija

Svaki test: seed salon + SoT → stage `FakeLlmClient` outputs → POST `/dev/simulate-inbound` → assert DB state + `mock_outbound_log` + `mock_contact_state`.

| # | Scenarij | Što testira |
|---|---|---|
| 1 | **Simple Q&A** — klijent pita o uslugama, bot odgovara per voice | Happy path: prompt builder, sanitizer pass-through, mock send |
| 2 | **Booking link dedup across turns** — turn 1 link + event, turn 2 isto pitanje, sanitizer ukloni link | Sanitizer dedup, event persistence, prompt context |
| 3 | **Tool escalate_to_owner** — fake LLM zove tool, backend stane | Tool dispatch, transactional state change, mock GHL tag/field calls, no outbound message |
| 4 | **Auto-resume after timeout** — seed escalation s `handoff_until` u prošlosti, run auto-resume worker | Recurring job, tag removal kroz mock, state cleanup |
| 5 | **Idempotent inbound + sanitizer empty escalates** — isti `ghl_message_id` 2x = 1 message; LLM vrati nešto što sanitizer prazni → escalation umjesto send | Edge cases, defense in depth |

Coalescing burst (3 poruke za 5s → 1 reply) je svjesno **van automatiziranog testa** (zahtijeva time mocking ili nedeterministički sleep). Pokriva manual smoke (curl burst skripta).

### 5.3 Test infrastruktura

- `vitest` s `setup-tests.ts` koji kreira test schema, runa migrations, resetira između testova kroz `TRUNCATE` (brže od recreate).
- `docker-compose.test.yml` profil s odvojenom postgres + redis instancom (drugi portovi od dev-a).
- `FakeLlmClient` s helper-om: `client.stage({ when: { lastUserMessage: /balayage/ }, then: { text: '...', toolCalls: [] } })`.
- CI workflow (GitHub Actions ili sl.): docker-compose up → migrations → `pnpm test` → `pnpm test:property`.

---

## 6. Phase plan — V1 mock (T1-T3)

Vertikalna kriška, 7 koraka. Svaki korak ima jasan deliverable i može se manualno verificirati.

### Korak 1: Skeleton end-to-end *(end of T1)*

- `pnpm init`, TypeScript strict, ESM, vitest config
- Deps install (lista u 1.2)
- `docker-compose.yml`: postgres 15 + redis 7
- Migrations 001: sve tablice iz base spec sekcije 3 + mock-only `mock_outbound_log`, `mock_contact_state`
- `src/index.ts` composition root sa stub-ovima:
  - **Stub `LlmClient`** vraća `"Hello! How can I help?"` (canned)
  - **Stub `sanitizer`** je identity passthrough
  - Real `MockGhlClient` (već dovoljno minimalan)
- `routes/webhooks-ghl-inbound.ts` (verify secret, validate, persist inbound)
- `routes/dev-simulate.ts` (loose schema)
- Sinhroni "respond" iz handler-a (bez BullMQ-a još): direktno pozove stub LLM + stub sanitizer + mock GHL send
- Manual smoke: `curl POST /dev/simulate-inbound` → vidi inbound u `messages`, vidi outbound u `mock_outbound_log`

**Deliverable**: end-to-end pipeline radi sa stubovima, sve granice na mjestu, `pnpm dev` zelen.

### Korak 2: Pravi sanitizer *(T2)*

- `src/sanitizer/index.ts` per base spec sekcija 5.2 (uključujući `splitOnSentenceBoundaries`)
- `tests/unit/sanitizer/fixtures/` ~30 parova (uključujući regression cases iz GHL-only sustava ako su dostupni)
- `tests/unit/sanitizer/property.spec.ts` — fast-check 10K iter za invariante iz 4.1
- ZAMIJENI passthrough stub iz Koraka 1
- `pnpm test:sanitizer` mora biti zelen

**Deliverable**: sanitizer 100% pokriven, ready za sve scenarije.

### Korak 3: Pravi DB sloj i repos *(T2)*

- `src/db/repos/salons.ts`, `conversations.ts`, `messages.ts`, `events.ts`, `escalations.ts`
- `routes/admin-salons.ts` — POST `/admin/salons` (validira SoT preko zod, sprema u DB)
- Salon lookup: in-memory cache (5 min TTL, invalidate on update u tom istom procesu)
- Idempotency: UNIQUE indeks na `messages.ghl_message_id` (već u migration-u iz Koraka 1)
- Seed script: kreira "Bella Hair Studio" iz fixture-a za dev
- `MockGhlClient` upgrade: `getMessage` koristi internal `Map<messageId, ...>` koja se popuni kroz `/dev/simulate-inbound` "fetch fallback" mod

**Deliverable**: prava persistencija, `/dev/simulate-inbound` čita/piše Postgres.

### Korak 4: Real LLM + prompt + tools *(T2-T3)*

- `src/llm/client.ts` `AnthropicLlmClient` (real)
- `src/prompt/build.ts` — system prompt (per base spec sekcija 7) + SoT injection + state + zadnjih 15 messages
- `src/prompt/tools.ts` — Anthropic tool schema za 3 toola
- `src/core/generate-response.ts` — load context → build prompt → llm.complete → tool dispatch → sanitize → send → persist
- `src/core/escalate.ts` — handler iz 4.2
- ZAMIJENI canned LLM stub iz Koraka 1
- Worker je još uvijek poziv unutar webhook handler-a (sinhrono); BullMQ stiže u idućem koraku
- Manual smoke: razgovor s pravim Claude API-jem o salonu, output kroz sanitizer u mock log

**Deliverable**: real LLM call → sanitize → mock send. Manual smoke prolazi.

### Korak 5: BullMQ + delay + coalescing *(T3)*

- `src/queue/index.ts` BullMQ setup (one queue: `respond`)
- `src/workers/respond.ts` — premjesti logiku iz Koraka 4 u BullMQ job handler
- Webhook handler: `queue.remove(jobId).catch(()=>{}); queue.add(...)` pattern za rolling delay
- Redis distributed lock (`SET NX EX 60`) u workeru
- Manual smoke: 3 curl-a za 5s → samo jedan bot reply (provjeri count u `mock_outbound_log`)

**Deliverable**: async pipeline s coalescing-om.

### Korak 6: Escalation flow *(T3)*

- Sve escalation putanje iz 4.3 wired (tool, sanitizer empty, LLM 3x fail, send fail)
- `routes/webhooks-ghl-resume.ts` — manual resume webhook
- `src/workers/auto-resume.ts` — BullMQ recurring (every 5 min)
- Manual smoke: full escalation lifecycle (tool call → tag added u mock state → vrijeme prođe / ručno makni tag → bot opet odgovara)

**Deliverable**: pun escalation lifecycle radi.

### Korak 7: Golden e2e + CI *(T3)*

- `tests/e2e/setup.ts` — schema reset, FakeLlmClient stage helper
- `tests/e2e/01-simple-qa.spec.ts` … `05-idempotent-and-sanitizer-empty.spec.ts`
- `docker-compose.test.yml` profil za CI
- CI workflow: docker-compose up → migrate → vitest run → property tests

**Deliverable**: CI zelen, sanitizer 100% + 5 golden e2e prolaze.

### 6.1 Realan timeline (Claude-assisted dev)

Pretpostavka: Claude Code piše većinu implementacijskog koda; korisnik vodi smoke testove, env setup, debugging integracije, daje feedback na PR-ove.

| Korak | Sadržaj | Fokusirani sati |
|---|---|---|
| 1 | Skeleton + Docker infra + prvi webhook end-to-end (sve stub) | 4-6h |
| 2 | Sanitizer + ~30 snapshot fixtures + property-based testovi | 2-3h |
| 3 | Migrations + Kysely repos + admin endpoint | 2-3h |
| 4 | LLM + prompt builder + tools + escalate.ts | 3-4h |
| 5 | BullMQ + coalescing pattern + Redis lock | 2-3h |
| 6 | Escalation flow wired + manual/auto resume | 2-3h |
| 7 | 5 golden e2e + CI workflow | 3-4h |

**Ukupno: ~18-26h fokusiranog rada → 3-5 kalendarskih dana** s pauzama, smoke testovima, debugging-om.

Riziko proširenja:
- Prvi put setup TypeScript ESM + Kysely migrations + Docker — može biti +2-4h zbog config gymnastics
- Anthropic SDK ili BullMQ breaking change u 2026 — može +2-4h
- Property-based testovi otkriju subtle sanitizer bug — može +2h iteracija

---

## 7. Out of scope (V2 / kasnije)

Eksplicitno NIJE u V1 mock fazi:

- ❌ Vision (image attachments → Claude Vision)
- ❌ Voice (Whisper transcribe)
- ❌ View-once / disappearing photo detection i instant escalate
- ❌ `direction='owner'` ulazne poruke (vlasnikov ručni odgovor kroz GHL UI)
- ❌ Real GHL HTTP integracija — ostaje `MockGhlClient` (T3-T4 base spec timeline)
- ❌ pgcrypto enkripcija PIT-ova (V1 plain text u dev DB)
- ❌ Sentry / Better Stack monitoring
- ❌ Health check job za neaktivne salone (Meta token re-auth alert)
- ❌ Per-conversation photo rate limit (LLM cost protection)
- ❌ Snapshot push-update tooling
- ❌ Admin web UI (samo cURL/HTTP)
- ❌ Token cost analytics dashboard

---

## 8. Open questions for real-GHL phase (kasnije)

Bilježimo da ne zaboravimo, ali NE rješavamo u V1 mock fazi:

1. **GHL plan tier potvrda** — salon mora imati Premium Workflow Actions i Snapshots dostupne. Provjeri prije onboarding-a prvog real klijenta.
2. **Workflow webhook merge tag coverage** — verify u GHL UI-u je li `{{message.body}}` i `{{message.attachments}}` stvarno dostupno na "Customer Replied" trigger-u za IG. Ako ne, `getMessage()` fallback radi, ali generira dodatni API poziv po inbound-u.
3. **PIT scope set** — minimalni skup: `conversations.write`, `conversations.readonly`, `contacts.write`, `contacts.readonly`, `locations.readonly`. Verify exact scope names u UI-u.
4. **PIT rotation policy** — preporuka 90 dana. Treba `PUT /admin/salons/{id}/pit` endpoint kasnije.
5. **Meta token re-auth UX** — kako vlasnik dobiva alert kad IG integracija expira (~60 dana)? V2: backend health check job.
6. **Snapshot push-update workflow** — ako mijenjamo logiku u workflow-ima (npr. dodajemo SMS fallback), kako rolloutamo na već onboarded salone? V2: agency operator runbook.

---

## 9. Reference

- Base spec: `AI_Salon_Receptionist_V1_Hybrid_Spec.pdf` (input dokument)
- GHL onboarding runbook: u brainstorming sesiji (poseban dokument)
- GHL Conversations API: https://highlevel.stoplight.io/docs/integrations/dbb2d3a30a015-send-a-new-message
- GHL Private Integration Tokens: https://marketplace.gohighlevel.com/docs/Authorization/PrivateIntegrationsToken/
- Anthropic SDK: https://github.com/anthropics/anthropic-sdk-typescript
- Kysely: https://kysely.dev
- BullMQ: https://docs.bullmq.io
