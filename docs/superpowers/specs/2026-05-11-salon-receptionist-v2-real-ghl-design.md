# AI Salon Receptionist — V2 Real GHL Integration Design

**Status**: Approved (brainstorming output)
**Date**: 2026-05-11
**Owner**: Ivan
**Predecessor**: [`2026-05-09-salon-receptionist-v1-mock-design.md`](./2026-05-09-salon-receptionist-v1-mock-design.md)
**Scope**: Zamjena `MockGhlClient` → `RealGhlClient`, konfiguracija GHL workflows + custom fields + PIT, live end-to-end test s pravim Instagram DM-om.

---

## 0. Context

V1 mock je kompletan (29/29 testova zelen, sve faze 1-7 mergeane na main). `GhlClient` interface i orkestracija (`handle-inbound.ts`, `generate-response.ts`, `escalate.ts`, sanitizer, repos) **se ne mijenjaju**. Boundary je ispravno postavljen — V2 dodaje samo:

1. Konkretan HTTP klijent (`RealGhlClient` u `src/ghl/real.ts`) koji implementira postojeći `GhlClient` interface
2. Factory pattern u composition root-u (per-salon client jer je PIT per-location)
3. Konfiguraciju u GHL UI-u: 3 workflows, 3 custom fields, 1 tag, 1 PIT
4. Cloudflared tunnel za izlaganje lokalnog backenda javnom HTTPS endpoint-u
5. Operator runbook za onboarding salona
6. Manual smoke test checklist (live na pravom IG-u)

### 0.1 Decisions table

| Decision | Value |
|---|---|
| Scope | Full V2: GHL config + RealGhlClient + live IG test |
| Deploy target za dev | Cloudflared tunnel preko localhost-a |
| GHL account state | Sub-account postoji, IG povezan |
| Owner notification kanal | Internal Notification — In-App push samo |
| Notification body | GHL contact detail deep-link (otvara DM thread unutar GHL appa) |
| Multi-salon scaling | Per-request factory `(salon) => GhlClient`, lazy cache po `salonId` |
| Phase approach | A — Vertical thin slice (isti pristup kao V1) |
| PIT encryption | Deferred za fazu E (production-ready); V2 dev koristi plaintext |

---

## 1. Arhitektura

```
┌──────────────────────────┐                      ┌─────────────────────────┐
│  GHL sub-account         │                      │  Backend                │
│  (Salon: Bella Hair)     │                      │  (Fastify + BullMQ      │
│                          │                      │   + Postgres + Redis)   │
│  ┌────────────────────┐  │  Custom Webhook      │                         │
│  │ Workflow #1        │──┼─POST /webhooks/ghl/──┼─▶ inbound route         │
│  │ trigger: Customer  │  │  inbound             │  → enqueue respond job  │
│  │   Replied (IG)     │  │                      │                         │
│  └────────────────────┘  │                      │                         │
│                          │                      │                         │
│  ┌────────────────────┐  │  Custom Webhook      │                         │
│  │ Workflow #2        │──┼─POST /webhooks/ghl/──┼─▶ resume route          │
│  │ trigger: Tag       │  │  resume              │  → clear handoff        │
│  │   `escalation_     │  │                      │                         │
│  │   active` REMOVED  │  │                      │                         │
│  └────────────────────┘  │                      │                         │
│                          │                      │                         │
│  ┌────────────────────┐  │                      │                         │
│  │ Workflow #3        │  │                      │                         │
│  │ trigger: Tag       │  │                      │                         │
│  │   `escalation_     │  │                      │                         │
│  │   active` ADDED    │  │                      │                         │
│  │ action: Internal   │  │                      │                         │
│  │   Notification     │  │                      │                         │
│  │   (In-App push)    │  │                      │                         │
│  └────────────────────┘  │                      │                         │
│                          │                      │   RealGhlClient calls:  │
│  GHL API endpoints       │◀─────────────────────┼── sendMessage           │
│  services.lead-          │  Bearer <PIT>        │   addTag/removeTag      │
│  connectorhq.com         │  Version: 2021-04-15 │   updateCustomField     │
│                          │                      │   getMessage (fallback) │
└──────────────────────────┘                      └─────────────────────────┘
                                                            │
                                                            ▼
                                            cloudflared tunnel daje
                                            javni HTTPS endpoint
                                            koji GHL workflows pozivaju
```

**Tokovi**:

- **Inbound** (klijent → bot): GHL workflow #1 fire-a na IG poruci, šalje HTTPS POST na naš `/webhooks/ghl/inbound`. Backend vrati 200 OK *odmah*, async procesira (rolling-delay coalescing + LLM + sanitize + send), šalje odgovor preko GHL API-ja (`POST /conversations/messages`).
- **Escalation** (bot → vlasnik): backend direktno preko GHL API-ja zove `addTag('escalation_active')` + `updateCustomField('last_escalation_reason', ...)`. GHL Workflow #3 fire-a na "tag added", izvodi Internal Notification → In-App push vlasniku.
- **Resume manual** (vlasnik handle-ao klijenta): vlasnik makne `escalation_active` tag iz GHL app-a. Workflow #2 fire-a, šalje POST na `/webhooks/ghl/resume`. Backend čisti `handoff_until` i `escalations.resumed_*` redak.
- **Resume auto** (4h timeout): backend BullMQ recurring job (svakih 5min) skenira `escalations WHERE resumed_at IS NULL AND handoff_until < now()`, makne tag direktno preko `RealGhlClient.removeTag`, clear-a state. Ne uključuje GHL workflow.

---

## 2. GHL konfiguracija (operator runbook)

Pet razdvojenih setup koraka koji se rade jednom po sub-accountu.

### 2.1 Custom Fields

Settings → Custom Fields → Contact, kreiraj tri:

| Naziv | Type | Opis |
|---|---|---|
| `Needs Owner Attention` | Single Line | flag string ("yes"/""), display-only |
| `Bot Paused Until` | Date/Time | ISO timestamp do kojeg je bot pauziran |
| `Last Escalation Reason` | Single Line | kratki razlog ("complaint", "sanitizer_empty", ...) |

Otvori svaki, kopiraj **Field ID** iz URL-a (`.../custom-fields/{uuid}`). UUID-ovi idu u `POST /admin/salons` body kao `config.ghl_custom_field_ids.{needs_owner_attention, bot_paused_until, last_escalation_reason}`.

### 2.2 Tag

Settings → Tags → New: **`escalation_active`** (lowercase, underscore). Točan string referenciraju Workflow #2, #3 i backend.

### 2.3 Private Integration Token

Settings → Private Integrations → Create:
- Name: `salon-receptionist-backend`
- Scopes (minimum):
  - `conversations.write`
  - `conversations.readonly`
  - `contacts.write`
  - `contacts.readonly`
  - `locations.readonly`
- **Kopiraj token odmah** (ne pokazuje se ponovno)

Token ide u `salons.ghl_pit`. Rotacija svakih ~90 dana preporučena. V2 followup: `PUT /admin/salons/{id}/pit` endpoint.

### 2.4 Workflow #1 — Inbound

Automation → Workflows → New → Start from Scratch.

- **Trigger**: `Customer Replied`
  - Filter: `Reply Channel = Instagram DM`
- **Action**: `Custom Webhook`
  - Method: `POST`
  - URL: `https://<tunnel>/webhooks/ghl/inbound`
  - Headers:
    - `Content-Type: application/json`
    - `X-Webhook-Secret: <WEBHOOK_SECRET iz backend .env>`
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

Save → **Publish**.

Ako `{{message.body}}` u nekim slučajevima dođe prazan (npr. attachment-only), backend automatski radi `getMessage(message_id)` API fallback. Workflow grananje nije potrebno.

### 2.5 Workflow #2 — Resume

- **Trigger**: `Contact Tag`
  - Filter: `Tag Removed = escalation_active`
- **Action**: `Custom Webhook`
  - Method: `POST`
  - URL: `https://<tunnel>/webhooks/ghl/resume`
  - Headers: isti `X-Webhook-Secret`
  - Body:
    ```json
    {
      "location_id": "{{location.id}}",
      "contact_id": "{{contact.id}}"
    }
    ```

Save → Publish.

### 2.6 Workflow #3 — Owner Internal Notification

- **Trigger**: `Contact Tag`
  - Filter: `Tag Added = escalation_active`
- **Action**: `Internal Notification`
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

GHL mobile app intercept-a `app.gohighlevel.com` URL-ove i otvara native screen — contact detail view sadrži IG DM thread direktno. Vlasnik može odgovoriti odatle i/ili maknuti tag.

Save → Publish.

---

## 3. RealGhlClient — backend implementacija

### 3.1 Bazni HTTP setup

Nova datoteka: `src/ghl/real.ts`. Implementira postojeći `GhlClient` interface iz `src/ghl/client.ts`.

```typescript
const GHL_BASE_URL = 'https://services.leadconnectorhq.com';
const GHL_API_VERSION = '2021-04-15';

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

export class RealGhlClient implements GhlClient {
  constructor(private pit: string, private locationId: string) {}

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const res = await fetch(`${GHL_BASE_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.pit}`,
        Version: GHL_API_VERSION,
        Accept: 'application/json',
        ...(body && { 'Content-Type': 'application/json' }),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      if (isOutsideWindowError(res.status, text)) {
        throw new OutsideMessagingWindowError(path, text);
      }
      throw new GhlApiError(res.status, path, text);
    }
    return res.json() as Promise<T>;
  }
}

function isOutsideWindowError(status: number, body: string): boolean {
  if (status !== 422 && status !== 400) return false;
  const lower = body.toLowerCase();
  return lower.includes('24') && (lower.includes('window') || lower.includes('messaging'));
}
```

### 3.2 Endpoints

| Metoda | Path | Body / Notes |
|---|---|---|
| `sendMessage` | `POST /conversations/messages` | `{ type: 'IG', contactId, message, locationId }` |
| `getMessage` | `GET /conversations/messages/{id}` | — |
| `addTag` | `POST /contacts/{id}/tags` | `{ tags: ['escalation_active'] }` |
| `removeTag` | `DELETE /contacts/{id}/tags` | `{ tags: ['escalation_active'] }` |
| `updateCustomField` | `PUT /contacts/{id}` | `{ customFields: [{ id, value }] }` |

`locationId` u send body-ju je obavezan (čak i s PIT-om koji je per-location).

### 3.3 Retry policy

| Slučaj | Reakcija |
|---|---|
| **5xx + mrežni timeout** | exp backoff retry: 500ms → 1.5s → 4s, max 2 retry-a. Nakon toga propagiraj `GhlApiError`. |
| **429** | Read `Retry-After` header (ako postoji), sleep, retry 1x. Drugi 429 → propagate. |
| **422/400 + 24h-window match** | Tipiziran `OutsideMessagingWindowError`. Ne retry-aj. `generate-response.ts` catch-a → escalate (`reason='cannot_reply_outside_window'`). |
| **401/403** | Ne retry-aj — auth fail. Log + propagate. Backend escalate-a (`reason='ghl_auth_failed'`) + set `salons.is_active=false`. |
| **404** | Ne retry-aj — config bug. Log + propagate. |
| **400 (ostalo)** | Ne retry-aj — programmer error. Log + propagate. |

### 3.4 Composition root: factory pattern

Multi-tenant zahtjev (PIT je per-location). Promjena u `src/index.ts` i `FastifyInstance['deps']`:

```typescript
// Prije:
// const ghl: GhlClient = new MockGhlClient(db);
// deps: { ghl, ... }

// Sada:
type GhlFactory = (salon: Salon) => GhlClient;

function makeGhlFactory(useMock: boolean, db: Db): GhlFactory {
  if (useMock) {
    const mock = new MockGhlClient(db);
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

const ghlFor: GhlFactory = makeGhlFactory(cfg.useMockGhl, db);
// deps: { ghlFor, ... }
```

Cache key je `salon.id`; cache se invalidira na PIT rotaciju (V2 followup endpoint će call-ati `cache.delete(salonId)`).

**Refactor scope**: `handle-inbound.ts` i `generate-response.ts` (i `escalate.ts`, `auto-resume.ts`) trenutno primaju `ghl: GhlClient`. Mijenjamo na `ghlFor: GhlFactory` + lookup `ghlFor(salon)` na ulasku u funkciju. Tests dodaju mock factory koji vraća jednu `MockGhlClient` instancu.

Env var `USE_MOCK_GHL` (default `false` u prod, `true` u testovima i dev-u dok ne configure-aš salon).

### 3.5 Što se NE mijenja

Sav postojeći V1 mock kod — sanitizer, prompt builder, tool dispatch, repos, route validation, idempotency, lock semantika, auto-resume scheduler — **ostaje isti**. Boundary interface je dobro postavljen.

---

## 4. Tunnel + env (lokalni dev)

### 4.1 Cloudflared

```powershell
# Install jednom
scoop install cloudflared

# Pokreni u zasebnom terminalu svaki dev session
cloudflared tunnel --url http://localhost:3000
```

Output sadrži javni HTTPS URL (`https://random-words-1234.trycloudflare.com`). URL se mijenja na restart — Workflow #1 i #2 URL-ovi se update-aju kroz GHL UI.

**Workaround za stabilan URL**: named tunnel (Cloudflare account + DNS). Investicija ~30min jednom, trajno stabilan endpoint.

### 4.2 .env additions

```env
GHL_API_BASE_URL=https://services.leadconnectorhq.com   # override za test
GHL_API_VERSION=2021-04-15
USE_MOCK_GHL=false                                       # true za potpuni test mode
```

`GHL_PIT` u env-u **NE postoji** — PIT je per-salon u `salons.ghl_pit`.

---

## 5. Deploy scenarij (produkcija)

U produkciji nema cloudflared random URL-a — backend dobiva stabilan javni HTTPS endpoint, hardcode-an u GHL workflows jednom.

| Setup | URL u GHL workflow-u |
|---|---|
| Cloud PaaS (Render / Fly / Railway) | `https://salon-backend.onrender.com/webhooks/ghl/inbound` |
| PaaS + custom domain | `https://api.tvojadomena.com/webhooks/ghl/inbound` |
| VPS + Caddy/nginx | `https://api.tvojadomena.com/...` |

Production secrets (env vars u Render / Fly / etc., NIKAD u repo):
```env
DATABASE_URL=<managed Postgres URL>
REDIS_URL=<managed Redis URL>
WEBHOOK_SECRET=<32+ bytes random>
ADMIN_API_KEY=<32+ bytes random>
LLM_PROVIDER=openai
OPENAI_API_KEY=<production key>
LLM_MODEL=gpt-4o-mini
USE_MOCK_GHL=false
```

Multi-tenant je već dizajn — jedan backend instance servisira N salona. Svaki sub-account šalje **isti backend URL**, ali s različitim `{{location.id}}` u payload-u. Backend rout-a po `location_id` → `salons` tablica.

**Migracija dev → prod**: jedini GHL-side rad je update URL-a u Workflow #1 i #2. ~2 minute po sub-accountu.

---

## 6. Onboarding novog salona (operator checklist)

### Pre-flight (GHL UI, ~10min)

1. Kreiraj 3 custom fielda (§2.1), zapamti UUID-eve
2. Kreiraj `escalation_active` tag (§2.2)
3. Kreiraj PIT (§2.3), kopiraj token
4. Kreiraj Workflow #1, #2, #3 (§2.4–2.6) s tunnel URL-om

### Backend side (~2min)

5. Napiši `source_of_truth` JSON za salon (V1 §4.7 schema)
6. `POST /admin/salons` payload:
   ```json
   {
     "display_name": "Bella Hair Studio",
     "ghl_location_id": "<location_id iz GHL URL-a>",
     "ghl_pit": "<token iz koraka 3>",
     "source_of_truth": { ... },
     "config": {
       "ghl_custom_field_ids": {
         "needs_owner_attention": "<uuid>",
         "bot_paused_until": "<uuid>",
         "last_escalation_reason": "<uuid>"
       }
     }
   }
   ```
7. Smoke S1 (vidi §8): test IG poruka → bot reply.

### Re-onboarding kad se tunnel URL promijeni

Update Workflow #1 i #2 URL-a. Backend, custom fields, PIT — ne diraj.

---

## 7. Error handling

### 7.1 Novi failure scenariji (V2 specific)

| Scenarij | Detekcija | Reakcija |
|---|---|---|
| GHL API 401/403 (PIT istekao) | `GhlApiError` status 401/403 | Log + escalate (`reason='ghl_auth_failed'`), set `salons.is_active=false`. Re-auth kroz V2 followup endpoint. |
| GHL 429 | Status 429 | Read `Retry-After`, sleep, retry 1x. Drugi 429 → escalate. |
| GHL 5xx | Status 500/502/503/504 | Exp backoff retry 2x. Onda V1 escalation. |
| 24h-window send fail | 422/400 + "window"/"24" u body-ju | `OutsideMessagingWindowError` → escalate (`reason='cannot_reply_outside_window'`). Ne retry-aj. |
| Tunnel down | GHL workflow ne dobije 200 | GHL ne retry-a Custom Webhook. Operator check. Postojeće poruke unread; kad tunel up, novi poruke će proć. |
| Webhook secret mismatch | Backend vrati 401 | GHL logira fail. Log warning. Najčešće: rotacija secret-a bez update-a u workflow-u. |
| Salon `is_active=false` | Lookup vraća inactive salon | 200 OK (ne želimo retry), log info, drop. |

### 7.2 Idempotency

V1 mock već koristi `UNIQUE(messages.ghl_message_id)` za inbound dedup. Workflow #1 može double-fire-ati u GHL retry edge case-ovima — backend silentno dropa. Isti mehanizam radi s real GHL-om kao s mockom. Bez dodatnog rada.

### 7.3 Što ostaje isto

LLM retry, sanitizer empty, lock semantika, auto-resume, conversation state, eskalacijski razlozi (osim 2 nova V2-specific) — identično V1 mock-u.

---

## 8. Manual smoke checklist

V1 e2e testovi (5 spec-ova s FakeLlmClient + MockGhlClient) i dalje rade i CI ih izvodi.

V2 dodatno: manual checklist po fazi, izvodi operator s pravim IG accountom.

| # | Scenarij | Korak | Očekivano |
|---|---|---|---|
| S1 | **Inbound happy path** | Pošalji "Bok, radite li balayage?" iz test IG-a | <5s: backend log "inbound persisted"; nakon `response_delay_ms`: bot reply u IG. `messages`: 2 redaka. |
| S2 | **Coalescing** | 3 poruke u 5s | 1 bot reply nakon delay-a od ZADNJE poruke. 3 inbound + 1 outbound u `messages`. |
| S3 | **Tool escalate** | Pošalji nešto što triggera escalate (npr. "Žalim se na frizera!") | Bot ne odgovara. GHL push push notif. Contact tag = `escalation_active`. `handoff_until` postavljen. |
| S4 | **Manual resume** | Vlasnik makne tag iz GHL app-a | Workflow #2 → backend /resume. `handoff_until=NULL`. Sljedeća poruka → bot odgovara. |
| S5 | **Auto resume** | Eskaliraj S3, postaviti `handoff_window_hours=0.05` u config-u za test | Auto-resume scheduler ukloni tag preko GHL API-ja. Tag više ne postoji. Bot reagira na sljedeću poruku. |
| S6 | **Idempotency** | (Pokriveno V1 e2e-om.) | — |
| S7 | **PIT auth fail** | `UPDATE salons SET ghl_pit='wrong'`, pošalji poruku | Backend log: GhlApiError 401. Escalation s razlogom `ghl_auth_failed`. Salon flagged. Vrati PIT, oporavi. |

---

## 9. Phase breakdown (5 faza, vertical thin slice)

| Faza | Sadržaj | Deliverable | Sati |
|---|---|---|---|
| **A — Setup** | Cloudflared install + tunnel; GHL custom fields/tag/PIT generirani; SoT napisan; `POST /admin/salons` succeeds | Backend zna za salon; GHL UI ima sve potrebno; bot ne reagira još | 2–3h |
| **B — Inbound + sendMessage** | Workflow #1 published; `RealGhlClient` skeleton + `sendMessage` + `getMessage`; factory pattern u composition root-u; **S1 + S2 pass** | Bot odgovara live na IG. Funkcionalan minimum. | 3–4h |
| **C — Escalation full** | `addTag` + `removeTag` + `updateCustomField`; Workflow #2 i #3 published; 24h-window error handling; **S3 + S4 pass** | Vlasnik prima push, manual resume radi. | 2–3h |
| **D — Auto-resume + edge cases** | Auto-resume scheduler poziva pravi `removeTag`; rate-limit/5xx retry policy; PIT auth failure handling; **S5 + S7 pass** | Sve failure paths testirano. | 2–3h |
| **E — Polish (opcionalno, prije prvog stvarnog klijenta)** | PIT encryption (pgcrypto); update `.env.example` + README; runbook commit; opcionalni named tunnel | Production-ready. | 2–4h |

**Ukupno A–D**: 9–13h fokusiranog rada = 1.5–2 kalendarska dana. Pause-point checkpoint nakon svake faze.

---

## 10. Out of scope (V3+ ili kasnije)

- ❌ Vision (image attachments → Claude/Gemini Vision)
- ❌ Voice (Whisper / Gemini Speech)
- ❌ View-once photo detection + instant escalate
- ❌ `direction='owner'` ulazne poruke (vlasnikov ručni odgovor kroz GHL UI kao signal)
- ❌ Sentry / Better Stack monitoring
- ❌ Health check job za Meta token re-auth alert (IG token expira ~60d)
- ❌ Per-conversation photo rate limit
- ❌ Snapshot template push-update tooling
- ❌ Admin web UI
- ❌ Token cost analytics dashboard

---

## 11. Reference

- V1 design: [`2026-05-09-salon-receptionist-v1-mock-design.md`](./2026-05-09-salon-receptionist-v1-mock-design.md)
- GHL Custom Webhook Action: https://help.gohighlevel.com/support/solutions/articles/155000003305-workflow-action-custom-webhook
- GHL Customer Replied Trigger: https://help.gohighlevel.com/support/solutions/articles/155000002677-workflow-trigger-customer-replied
- GHL Contact Tag Trigger: https://help.gohighlevel.com/support/solutions/articles/155000002482-workflow-trigger-contact-tag
- GHL Internal Notifications: https://help.gohighlevel.com/support/solutions/articles/155000003202-workflow-action-internal-notification
- GHL Private Integration Tokens: https://marketplace.gohighlevel.com/docs/Authorization/PrivateIntegrationsToken/
- GHL Conversations API: https://highlevel.stoplight.io/docs/integrations/dbb2d3a30a015-send-a-new-message
- Cloudflared Tunnels: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/
