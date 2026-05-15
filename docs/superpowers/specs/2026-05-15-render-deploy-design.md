# Render Production Deploy Design

**Status**: Approved (brainstorming output)
**Date**: 2026-05-15
**Owner**: Ivan
**Predecessor**: [`2026-05-11-salon-receptionist-v2-real-ghl-design.md`](./2026-05-11-salon-receptionist-v2-real-ghl-design.md)
**Scope**: Production deploy V1 sustava (V1 mock + V2 real GHL) na Render.com. Single backend service + managed Postgres + managed Key Value (Redis-compatible). Free tier početak, planirani upgrade pred prvog stvarnog klijenta.

---

## 0. Context

V2 implementacija je gotova (sve commits do `7bbec8a` + 273bebd test fix). Sustav radi live na vlastitom IG-u kroz cloudflared tunnel. Sad treba public, persistent HTTPS endpoint za GHL workflowe da fire-aju neovisno o lokalnom dev terminalu.

### 0.1 Decisions table

| Decision | Value |
|---|---|
| Host | Render.com (najmanji friction; managed PG + KV; auto-deploy iz GitHub-a) |
| Tier | Free start, upgrade pred prvog stvarnog klijenta (Starter Web $7 + Starter PG $7 + Starter KV $10 ≈ $25/mes) |
| Domain | `salon-backend.onrender.com` za sad; custom domena V3 polish |
| Infrastructure as Code | `render.yaml` Blueprint u repo (rebuildable) |
| Auto-deploy | GitHub `main` push → Render rebuilds (no GHA gate u V1; cijena: $19/mes Org plan) |
| CI/CD | GHA workflow (unchanged) radi typecheck + tests; Render rebuilds neovisno (deploy może fire-at čak ako GHA crveni — operator pažljivo gleda) |
| LLM provider | Globalan env (Sekcija A.4 V2 spec); Render env vars u dashboardu (sync: false) |
| Secrets generation | Render auto-generates `WEBHOOK_SECRET` i `ADMIN_API_KEY`; operator generira `PIT_ENCRYPTION_KEY` lokalno i paste-a |
| Keep-alive | `cron-job.org` ping `/health` svakih 10 min (free tier spava nakon 15min idle) |

---

## 1. Arhitektura

```
GitHub repo (sm_chatbot, branch: main)
    │ git push trigger
    ▼
Render Web Service "salon-backend"
    ├── Build: npm ci && npm run build (tsc → dist/)
    ├── Pre-deploy: npm run migrate:up:prod (compiled JS)
    ├── Start: npm start (node dist/index.js)
    ├── HealthCheck: GET /health
    └── HTTPS endpoint: https://salon-backend.onrender.com
         │
         ├─ inbound from GHL workflows (Custom Webhook actions)
         ├─ outbound HTTP → GHL API (services.leadconnectorhq.com)
         └─ outbound HTTP → LLM provider (Gemini / OpenAI / Anthropic)
         │
         ├─ DATABASE_URL → Render Postgres "salon-pg" (TLS, internal)
         └─ REDIS_URL → Render Key Value "salon-kv" (TLS, internal)
```

Free tier limitations:
- **Web Service spava nakon 15 min idle** → keep-alive cron ping
- **PG Free expires nakon 90 dana** → moramo upgrade-at PG na Starter prije isteka
- **KV Free 25MB limit** → dovoljno za BullMQ s 1-2 active salons

---

## 2. Code changes (4 fajla)

### 2.1 `package.json` scripts + engines

```json
"scripts": {
  "dev": "tsx watch src/index.ts",
  "build": "tsc",
  "start": "node dist/index.js",
  "migrate:up": "tsx src/db/migrate.ts up",
  "migrate:up:prod": "node dist/db/migrate.js up",
  "migrate:down": "tsx src/db/migrate.ts down",
  ...
},
"engines": {
  "node": ">=20"
}
```

Razlog `migrate:up:prod`: production-time tsx nije dostupno (pruned ili nije instalirano); koristimo compiled JS.

### 2.2 `src/db/migrate.ts` — static migration provider

`FileMigrationProvider` koristi `import('./0001_initial.ts')` dinamički. Node prod ESM ne može učitati .ts. Već smo isti fix radili u `tests/helpers/test-db.ts` (commit `2aaad70`). Replicrat za migrate.ts:

```typescript
import { Kysely, Migrator, PostgresDialect, sql, type Migration, type MigrationProvider } from 'kysely';
import pg from 'pg';
import 'dotenv/config';
import { logger } from '../lib/logger.js';
import * as migration0001 from './migrations/0001_initial.js';

const staticProvider: MigrationProvider = {
  async getMigrations(): Promise<Record<string, Migration>> {
    return { '0001_initial': migration0001 as Migration };
  },
};

async function run() {
  const direction = (process.argv[2] ?? 'up') as 'up' | 'down';
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) { logger.error('DATABASE_URL not set'); process.exit(1); }
  const isLocal = databaseUrl.includes('localhost') || databaseUrl.includes('127.0.0.1');
  const db = new Kysely<unknown>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({
        connectionString: databaseUrl,
        ssl: isLocal ? false : { rejectUnauthorized: false },
      }),
    }),
  });
  const migrator = new Migrator({ db, provider: staticProvider });
  // ... rest unchanged ...
}
```

Kasnije migracije: dodaj static import + entry u objektu.

### 2.3 `src/db/kysely.ts` — conditional SSL

```typescript
export function createKyselyDb(databaseUrl: string): Kysely<Database> {
  const isLocal = databaseUrl.includes('localhost') || databaseUrl.includes('127.0.0.1');
  return new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({
        connectionString: databaseUrl,
        max: 10,
        ssl: isLocal ? false : { rejectUnauthorized: false },
      }),
    }),
  });
}
```

Lokalno docker-compose i dalje radi bez TLS-a; Render PG dobiva TLS automatski.

### 2.4 `render.yaml` (novi fajl)

```yaml
services:
  - type: web
    name: salon-backend
    runtime: node
    plan: free
    buildCommand: npm ci && npm run build
    startCommand: npm start
    preDeployCommand: npm run migrate:up:prod
    healthCheckPath: /health
    envVars:
      - key: NODE_VERSION
        value: "20"
      - key: NODE_ENV
        value: production
      - key: PORT
        value: "3000"
      - key: DATABASE_URL
        fromDatabase:
          name: salon-pg
          property: connectionString
      - key: REDIS_URL
        fromService:
          name: salon-kv
          type: keyvalue
          property: connectionString
      - key: LLM_PROVIDER
        sync: false
      - key: GEMINI_API_KEY
        sync: false
      - key: OPENAI_API_KEY
        sync: false
      - key: ANTHROPIC_API_KEY
        sync: false
      - key: LLM_MODEL
        sync: false
      - key: WEBHOOK_SECRET
        generateValue: true
      - key: ADMIN_API_KEY
        generateValue: true
      - key: PIT_ENCRYPTION_KEY
        sync: false
      - key: USE_MOCK_GHL
        value: "false"

  - type: keyvalue
    name: salon-kv
    plan: free
    maxmemoryPolicy: noeviction
    ipAllowList: []

databases:
  - name: salon-pg
    plan: free
    databaseName: salon
    user: salon
```

---

## 3. Operator setup (prvi deploy)

1. Code changes iz §2 commit + push na `origin/main`. CI mora proći.
2. Render Dashboard → New → Blueprint → connect `sm_chatbot` repo → Apply
3. Env Service `salon-backend` → Environment tab → postaviti `sync: false` polja: `LLM_PROVIDER`, `<LLM>_API_KEY`, `LLM_MODEL`, `PIT_ENCRYPTION_KEY` (generiraj lokalno: `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"`)
4. Kopiraj auto-generated `WEBHOOK_SECRET` i `ADMIN_API_KEY` u notepad
5. Verify: `curl https://salon-backend.onrender.com/health` → 200 ok
6. Onboard salon: `curl -X POST /admin/salons -H "Authorization: Bearer $ADMIN_KEY" --data @scratch/salon-onboarding.json`
7. Update GHL Workflow #1 i #2 URL-ove → `https://salon-backend.onrender.com/webhooks/ghl/{inbound,resume}` + `X-Webhook-Secret` na novi secret
8. Smoke: pošalji IG DM → Render logs treba pokazati `http request received` → `sending message to ghl` → bot odgovori
9. Keep-alive: cron-job.org → ping `/health` svakih 10 min
10. (V3 polish) Custom domain via Render Settings → Custom Domain

---

## 4. Post-deploy ops

### 4.1 Secrets rotation

| Secret | Cadence | Postupak |
|---|---|---|
| `WEBHOOK_SECRET` | Annual / ad-hoc | Render regenerate → update GHL Workflow #1, #2 headers |
| `ADMIN_API_KEY` | Annual | Render regenerate → update curl/admin tools |
| `PIT_ENCRYPTION_KEY` | NIKAD nakon prvog encrypt-a | Ako mora: dec-then-reenc migration script + key versioning (V3) |
| `salons.ghl_pit` (per-salon) | 90 dana | Generate u GHL UI → `UPDATE salons SET ghl_pit=...` (encrypt auto) |
| LLM API key | Ad-hoc na incident | Provider UI → update Render env → redeploy |

### 4.2 Logs + monitoring

- Logs: Render dashboard → Logs tab. Pino JSON output filterable by `salonId`, `conversationId`. Retention 7d free / 30d paid.
- Alerts (V3): Render Service Health alerts via email; Better Stack / Sentry za napredno tracking.
- Metrics: Render Service → Metrics tab (CPU / Memory / Bandwidth).

### 4.3 Backups

- PG: Free 30d daily snapshot retention. Restore via dashboard → Backups → Restore.
- Redis (BullMQ): kratkotrajni jobs, gubitak = klijent ne dobije reply na tu poruku (ne katastrofa). Nema dedicated backup.

### 4.4 Rollback

Render dashboard → Service → Deploys → klikni prethodni → Rollback to this deploy. <1 min.

### 4.5 Upgrade triggers

| Trigger | Upgrade | Cijena |
|---|---|---|
| Prvi stvarni klijent | Web Free → Starter (always-on) | $7/mes |
| PG dan 80 (10d pred 90d isteka) | PG Free → Starter | $7/mes |
| >1 conversation/min sustained | KV Free → Starter (više memorije) | $10/mes |
| 5+ salona, multi-region | Razmotri Fly.io ili Render multi-region | varijabilno |

### 4.6 CI/CD policy

GHA i Render deploy idu **neovisno**. Operator gleda GHA status pre push-a. Ako želiš strict gate (Render čeka GHA green), Render Org Pro plan ($19/mes) ili manual deploy mode.

---

## 5. Out of scope

- Custom domain setup (V3 polish, ~30min jednokratno)
- Sentry / Better Stack monitoring + alerts (V3)
- Staging environment (multi-env workflow — kad team raste)
- Multi-region deploy (Fly.io migration — 5+ salona)
- Render Pro plan features (gated deploys, advanced metrics)
- PIT rotation endpoint (V3 — currently manual DB update)
- Snapshot push-update tooling (V3 — multi-tenant ops)

---

## 6. References

- V2 design: [`2026-05-11-salon-receptionist-v2-real-ghl-design.md`](./2026-05-11-salon-receptionist-v2-real-ghl-design.md)
- Render Blueprint docs: https://render.com/docs/blueprint-spec
- Render Postgres: https://render.com/docs/postgresql
- Render Key Value: https://render.com/docs/key-value
- Render Auto-Deploys: https://render.com/docs/deploys
- cron-job.org (keep-alive): https://cron-job.org
