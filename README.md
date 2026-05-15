# Salon Receptionist

AI receptionist for hair salons. Hybrid architecture: GoHighLevel as Instagram DM transport + custom backend for conversation logic (LLM + sanitizer + escalation).

## Stack

- TypeScript ESM strict, Node 20+
- Fastify (HTTP), BullMQ (queue), Kysely (typed SQL builder)
- Postgres 15, Redis 7 (via docker-compose)
- vitest for tests
- Gemini / OpenAI / Anthropic LLM (configurable via env)

## Quick start (local dev)

### 1. Boot infra

```bash
docker compose up -d           # Postgres + Redis
npm install
cp .env.example .env           # then edit values
npm run migrate:up
```

### 2. Run backend + tunnel (two terminals)

```bash
# Terminal 1
npm run dev

# Terminal 2 — public HTTPS URL for GHL webhooks
cloudflared tunnel --url http://127.0.0.1:3000
```

Copy the `https://*.trycloudflare.com` URL — needed for GHL workflow webhook config.

### 3. Smoke test (mock mode)

```bash
curl -X POST http://localhost:3000/dev/simulate-inbound \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: dev-secret-change-me" \
  -d '{"location_id":"loc_1","contact_id":"c_1","message_text":"hello"}'
```

## Onboarding a new salon

Full step-by-step in [`docs/superpowers/specs/2026-05-11-salon-receptionist-v2-real-ghl-design.md`](docs/superpowers/specs/2026-05-11-salon-receptionist-v2-real-ghl-design.md) §6. Short version:

### GHL UI setup (~10 min, done once per sub-account)

1. **Custom fields** — Settings → Custom Fields → Contact, create three:

   | Name | Type |
   |---|---|
   | `Needs Owner Attention` | Single Line |
   | `Bot Paused Until` | Date/Time |
   | `Last Escalation Reason` | Single Line |

   Open each field and copy its **Field ID** UUID from the URL — needed for the `POST /admin/salons` body.

2. **Tag** — Settings → Tags → New: `escalation_active` (lowercase, underscore).

3. **Private Integration Token** — Settings → Private Integrations → Create with scopes:
   `conversations.write`, `conversations.readonly`, `contacts.write`, `contacts.readonly`, `locations.readonly`.
   Copy the token immediately (shown only once).

4. **Workflows** — Automation → Workflows → New → Start from Scratch:

   - **Workflow #1 Inbound**: trigger `Customer Replied` (filter: Instagram DM) → action `Custom Webhook` POST `https://<tunnel>/webhooks/ghl/inbound` with header `X-Webhook-Secret: <value>` and body `{"location_id":"{{location.id}}","contact_id":"{{contact.id}}","contact_handle":"{{contact.instagram}}","message_id":"{{message.id}}","message_text":"{{message.body}}"}`. Publish.
   - **Workflow #2 Resume**: trigger `Contact Tag` (Tag Removed = `escalation_active`) → Custom Webhook POST `https://<tunnel>/webhooks/ghl/resume` with same secret header and body `{"location_id":"{{location.id}}","contact_id":"{{contact.id}}"}`. Publish.
   - **Workflow #3 Notify**: trigger `Contact Tag` (Tag Added = `escalation_active`) → Internal Notification (In-App, owner as recipient). Publish.

   See spec §2.4–§2.6 for exact field values.

### Backend registration (~2 min)

```bash
curl -X POST http://localhost:3000/admin/salons \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -d '{
    "display_name": "Bella Hair Studio",
    "ghl_location_id": "<location_id from GHL URL>",
    "ghl_pit": "<PIT token from step 3>",
    "source_of_truth": { ... },
    "config": {
      "ghl_custom_field_ids": {
        "needs_owner_attention": "<uuid>",
        "bot_paused_until": "<uuid>",
        "last_escalation_reason": "<uuid>"
      }
    }
  }'
```

`source_of_truth` schema: V1 design spec §4.7.

### When the tunnel URL changes

Update Workflow #1 and #2 URLs in GHL. Backend, custom fields, PIT — leave untouched.

## Testing

```bash
npm run test           # full suite (unit + e2e)
npm run test:unit      # unit only (fast, no DB required)
npm run test:e2e       # e2e — requires test Postgres on :55432
```

CI runs typecheck + migrations + all tests (`.github/workflows/ci.yml`).

## Production deploy

See [V2 design spec §5](docs/superpowers/specs/2026-05-11-salon-receptionist-v2-real-ghl-design.md) for full details. Quick options:

- **Render.com** (recommended for first deploy): managed Postgres + Key Value (Redis) add-ons, GitHub auto-deploy
- **Fly.io** (multi-region capable)
- **VPS + Caddy/nginx**

Required production env vars (never in repo):

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

Multi-tenant by design — one backend instance serves N salons. Each sub-account sends the same backend URL; routing is by `location_id` → `salons` table.

Migrating dev → prod: the only GHL-side work is updating the URL in Workflow #1 and #2. ~2 minutes per sub-account.

## Architecture

- V1 mock design: [`docs/superpowers/specs/2026-05-09-salon-receptionist-v1-mock-design.md`](docs/superpowers/specs/2026-05-09-salon-receptionist-v1-mock-design.md)
- V2 real GHL: [`docs/superpowers/specs/2026-05-11-salon-receptionist-v2-real-ghl-design.md`](docs/superpowers/specs/2026-05-11-salon-receptionist-v2-real-ghl-design.md)
- Implementation plans in `docs/superpowers/plans/`

## Troubleshooting

- **Bot not replying live**: check dev terminal — if no `http request received` log on IG DM, the tunnel URL in GHL workflow is stale. Cloudflared restart = new random URL; update both Workflow #1 and #2.
- **`webhook secret mismatch` warning**: `.env` `WEBHOOK_SECRET` must match the `X-Webhook-Secret` header set in GHL workflows. Single line, no embedded newlines.
- **`401 not authorized for this scope`**: GHL PIT is missing one of the 5 required scopes. Recheck in GHL UI → Private Integrations.
- **GHL workflow body has literal `null` for `{{message.id}}`**: handled by route normalization — string `"null"` / `"undefined"` values are treated as JS `null`.
- **Tunnel down**: GHL does not retry Custom Webhook failures. Messages sent while the tunnel is down will be missed; new messages after tunnel restart will be processed normally.
