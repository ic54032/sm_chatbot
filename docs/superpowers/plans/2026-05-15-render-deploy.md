# Render Production Deploy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the salon-receptionist V1 (mock + real GHL) deployable to Render.com via a `render.yaml` Blueprint, with production-safe DB/Redis connections and a build pipeline that compiles TypeScript → JS for `node dist/index.js`.

**Architecture:** Single Render Web Service runs Fastify + BullMQ workers (in-process), backed by Render managed Postgres + Key Value (Redis-compatible). Pre-deploy hook runs migrations against the compiled JS. Free tier for V1; planned upgrade before first real client.

**Tech Stack:** TypeScript ESM strict (Node 20+), Fastify, BullMQ, Kysely + pg, ioredis, Render Blueprint (YAML).

**Pause-points:** Per user's "stop after each phase" memory — there's only one phase here (code change), pauza je nakon T4 prije operator Render Blueprint setup-a (T5 = manual operator action).

---

## Spec reference

[`docs/superpowers/specs/2026-05-15-render-deploy-design.md`](../specs/2026-05-15-render-deploy-design.md)

## File map

**Create:**
- `render.yaml` — Render Blueprint (services + databases + envVars)

**Modify:**
- `package.json` — add `migrate:up:prod` script + `engines.node`
- `src/db/migrate.ts` — switch from `FileMigrationProvider` to static migration provider (mirrors `tests/helpers/test-db.ts` pattern, commit `2aaad70`)
- `src/db/kysely.ts` — add conditional SSL for non-localhost DATABASE_URL

**Unchanged:** all other src/, tests/, infra, GHA workflow. The Render free tier setup is operator-side after these 4 changes ship to main.

---

## Task 1: `package.json` — add prod migrate script + engines

**Files:**
- Modify: `c:\sm_chatbot\package.json`

- [ ] **Step 1: Read the current package.json scripts block**

```bash
cat package.json
```

Confirm current scripts include `migrate:up` and `migrate:down` using `tsx`. Also confirm there is no `engines` field yet.

- [ ] **Step 2: Add `migrate:up:prod` script and `engines.node`**

Use the Edit tool. Two changes:

A) After the `"migrate:up": "tsx src/db/migrate.ts up",` line, insert a new line:

```json
"migrate:up:prod": "node dist/db/migrate.js up",
```

B) After the closing `}` of `"devDependencies": {...}`, add a top-level `engines` block before the final `}` of the document:

```json
,
"engines": {
  "node": ">=20"
}
```

Final relevant fragment:

```json
"scripts": {
  ...
  "migrate:up": "tsx src/db/migrate.ts up",
  "migrate:up:prod": "node dist/db/migrate.js up",
  "migrate:down": "tsx src/db/migrate.ts down",
  ...
},
"dependencies": { ... },
"devDependencies": { ... },
"engines": {
  "node": ">=20"
}
```

- [ ] **Step 3: Verify JSON parses**

```bash
node -e "console.log(JSON.parse(require('fs').readFileSync('package.json')).scripts['migrate:up:prod'])"
```

Expected: `node dist/db/migrate.js up`

- [ ] **Step 4: Verify typecheck still passes (no production code touched, sanity)**

```bash
rtk proxy npm run lint
```

Expected: clean (no output, exit 0).

- [ ] **Step 5: Commit**

```bash
git add package.json
git commit -m "feat(deploy): add migrate:up:prod script + engines.node>=20"
```

---

## Task 2: `src/db/kysely.ts` — conditional SSL for Render PG

**Files:**
- Modify: `c:\sm_chatbot\src\db\kysely.ts`

- [ ] **Step 1: Read the current file**

```bash
cat src/db/kysely.ts
```

Confirm: `createKyselyDb(databaseUrl)` constructs `new pg.Pool({ connectionString: databaseUrl, max: 10 })` without any SSL option.

- [ ] **Step 2: Replace `createKyselyDb` body with conditional SSL**

Use the Edit tool. Replace:

```typescript
export function createKyselyDb(databaseUrl: string): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString: databaseUrl, max: 10 }),
    }),
  });
}
```

With:

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

- [ ] **Step 3: Verify typecheck**

```bash
rtk proxy npm run lint
```

Expected: clean.

- [ ] **Step 4: Verify unit tests still pass (no logic change in code paths exercised by unit tests)**

```bash
rtk proxy npm run test:unit
```

Expected: 78/78 unit tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/db/kysely.ts
git commit -m "feat(deploy): conditional SSL on createKyselyDb (relaxed verify off-localhost)"
```

---

## Task 3: `src/db/migrate.ts` — switch to static migration provider

**Files:**
- Modify: `c:\sm_chatbot\src\db\migrate.ts`

**Why:** `FileMigrationProvider` uses dynamic `import()` of `.ts` files at runtime — Node ESM in production has no TS loader and rejects. We already fixed the same bug for tests in commit `2aaad70` by switching `tests/helpers/test-db.ts` to a static migration provider. Replicate that pattern here.

- [ ] **Step 1: Read the current migrate.ts**

```bash
cat src/db/migrate.ts
```

Confirm uses `FileMigrationProvider` + `urlPath` workaround + `fs` import.

- [ ] **Step 2: Replace entire file with static-provider version**

Use the Write tool. Replace ENTIRE contents of `src/db/migrate.ts` with:

```typescript
import 'dotenv/config';
import { Kysely, Migrator, PostgresDialect, type Migration, type MigrationProvider } from 'kysely';
import pg from 'pg';
import { logger } from '../lib/logger.js';
import * as migration0001 from './migrations/0001_initial.js';

// Static migration provider — avoids kysely FileMigrationProvider's dynamic
// import() of .ts files, which Node ESM rejects in production (no TS loader).
// Same fix applied to tests/helpers/test-db.ts in commit 2aaad70.
const staticProvider: MigrationProvider = {
  async getMigrations(): Promise<Record<string, Migration>> {
    return {
      '0001_initial': migration0001 as Migration,
    };
  },
};

async function run() {
  const direction = (process.argv[2] ?? 'up') as 'up' | 'down';
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    logger.error('DATABASE_URL not set');
    process.exit(1);
  }

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

  const { error, results } = direction === 'up'
    ? await migrator.migrateToLatest()
    : await migrator.migrateDown();

  results?.forEach((r) => {
    if (r.status === 'Success') logger.info({ migration: r.migrationName, direction: r.direction }, 'migration ok');
    else if (r.status === 'Error') logger.error({ migration: r.migrationName }, 'migration failed');
  });

  if (error) {
    logger.error({ err: error }, 'migration error');
    process.exit(1);
  }

  await db.destroy();
}

run();
```

- [ ] **Step 3: Verify typecheck**

```bash
rtk proxy npm run lint
```

Expected: clean.

- [ ] **Step 4: Verify all tests still pass**

```bash
rtk proxy npm run test
```

Expected: 78 unit tests pass; 5 e2e suites fail with `ECONNREFUSED` on `:55432` (pre-existing — no local test Postgres).

- [ ] **Step 5: Verify `migrate:up:prod` would resolve correctly after build**

```bash
rtk proxy npm run build
```

Expected: `dist/` produced. Then:

```bash
ls dist/db/migrate.js dist/db/migrations/0001_initial.js
```

Expected: both files exist. (Confirms the new static import resolves through compiled output.)

- [ ] **Step 6: Commit**

```bash
git add src/db/migrate.ts
git commit -m "fix(deploy): migrate.ts uses static provider so compiled JS resolves (no runtime .ts import)"
```

---

## Task 4: `render.yaml` — Blueprint for services + DB + Key Value

**Files:**
- Create: `c:\sm_chatbot\render.yaml`

- [ ] **Step 1: Create `render.yaml`**

Use the Write tool. New file `c:\sm_chatbot\render.yaml`:

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

- [ ] **Step 2: YAML lint check (optional but cheap)**

```bash
node -e "const yaml = require('fs').readFileSync('render.yaml','utf8'); console.log(yaml.length, 'bytes, starts:', yaml.slice(0,30))"
```

Expected: prints non-zero byte count and the literal `services:` start. (No YAML parser dependency — just byte sanity.)

- [ ] **Step 3: Verify no TypeScript impact**

```bash
rtk proxy npm run lint
```

Expected: clean (render.yaml is not TS).

- [ ] **Step 4: Commit**

```bash
git add render.yaml
git commit -m "feat(deploy): render.yaml Blueprint (web + postgres + key-value, free tier)"
```

---

## Task 5: Push + Render Blueprint setup (operator action)

This task is NOT subagent-dispatchable. After T1-T4 land on `main` and CI green, operator runs the Render dashboard steps from spec §3. Summary:

- [ ] **Step 1: Push commits to origin/main**

```bash
git push origin main
```

Verify GHA CI green on `https://github.com/<user>/sm_chatbot/actions` before continuing.

- [ ] **Step 2: Render Blueprint**

1. https://render.com → Sign Up with GitHub (autorizes read)
2. Dashboard → New → Blueprint → Connect `sm_chatbot` → Apply
3. Render auto-creates: Web Service `salon-backend`, PG `salon-pg`, KV `salon-kv`. PG provisioning ~2 min.

- [ ] **Step 3: Set sync:false env vars in Render dashboard**

Service `salon-backend` → Environment tab. Set the values:

| Key | Value source |
|---|---|
| `LLM_PROVIDER` | `gemini` (or `openai`/`anthropic`) |
| `GEMINI_API_KEY` (or equiv) | Google AI Studio → Get API Key |
| `LLM_MODEL` | `gemini-2.5-flash` (or per provider) |
| `PIT_ENCRYPTION_KEY` | Run locally: `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"` — paste output |

Auto-generated by Render (copy these to a notepad after first deploy):
- `WEBHOOK_SECRET`
- `ADMIN_API_KEY`

Save. Render auto-redeploys.

- [ ] **Step 4: Verify deploy**

```bash
curl https://salon-backend.onrender.com/health
```

Expected: `{"status":"ok","ts":"..."}`.

Render dashboard → Logs tab should show: `INFO: server listening; respond worker active port=3000` and no ECONNREFUSED on PG or Redis.

- [ ] **Step 5: Onboard first salon through prod backend**

```bash
ADMIN_KEY='<paste-from-render>'
curl -X POST https://salon-backend.onrender.com/admin/salons \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ADMIN_KEY" \
  --data @scratch/salon-onboarding.json
```

Expected: 201 + salon ID. Verify in DB via Render PG dashboard's psql shell:

```sql
SELECT id, display_name, is_active FROM salons;
```

- [ ] **Step 6: Update GHL Workflow URLs**

In your GHL sub-account, for each workflow:

- Workflow #1 (Inbound) → Custom Webhook URL = `https://salon-backend.onrender.com/webhooks/ghl/inbound`
- Workflow #2 (Resume) → Custom Webhook URL = `https://salon-backend.onrender.com/webhooks/ghl/resume`
- Header `X-Webhook-Secret` value = `WEBHOOK_SECRET` from Render dashboard

Save → Publish both.

- [ ] **Step 7: Smoke test live**

From a test IG account, send a DM to the connected salon IG. Render Logs tab should show within ~3-5s:

```
http request received POST /webhooks/ghl/inbound
inbound persisted
respond job queued
sending message to ghl
```

Bot replies in IG within ~5-12s.

- [ ] **Step 8: Keep-alive cron**

Go to https://cron-job.org (free, no signup for basic):
1. Create new cron job
2. URL: `https://salon-backend.onrender.com/health`
3. Interval: every 10 minutes
4. Save

This keeps the Render free Web Service from spinning down after 15min idle.

---

## Self-review

**Spec coverage:**

| Spec §  | What it requires | Task that implements it |
|---|---|---|
| §0.1 (decisions) | Render host, free tier start, env via sync:false, etc. | All tasks reflect these decisions |
| §1 (architecture) | Single Web Service + managed PG + managed KV | T4 (render.yaml) |
| §2.1 (package.json) | migrate:up:prod + engines.node | T1 |
| §2.2 (migrate.ts) | static provider | T3 |
| §2.3 (kysely.ts) | conditional SSL | T2 |
| §2.4 (render.yaml) | Blueprint | T4 |
| §3 (operator setup) | Push + Render Blueprint + env vars + smoke | T5 |
| §4 (post-deploy ops) | Documented in spec; no code task needed |
| §5 (out of scope) | Documented in spec; no code task needed |

All four code changes plus the operator runbook are covered.

**Placeholder scan:** every step has exact code, exact command, or exact dashboard click. No "TBD" / "TODO" / "implement later".

**Type consistency:**
- `createKyselyDb(databaseUrl)` signature unchanged across T2.
- `isLocal` heuristic used identically in T2 and T3.
- `migrate:up:prod` script name in T1 matches `preDeployCommand` reference in T4.
- `salon-backend`, `salon-pg`, `salon-kv` service names consistent across T4 + T5.
- `WEBHOOK_SECRET`, `ADMIN_API_KEY`, `PIT_ENCRYPTION_KEY` env var names match V2 design + existing config.

**Estimated effort:**
- T1: 5 min
- T2: 5 min
- T3: 10 min
- T4: 5 min
- T5: 30-45 min (operator, not subagent)

Subagent code work: ~25 min total across T1-T4 (small focused diffs).
