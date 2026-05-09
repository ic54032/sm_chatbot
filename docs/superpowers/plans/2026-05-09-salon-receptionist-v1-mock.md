# AI Salon Receptionist V1 Mock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implementiraj V1 mock fazu AI Salon Receptionist sustava — kompletna conversation logika, sanitizer, persistencja, job queue i escalation flow protiv `MockGhlClient`-a, spremno za zamjenu real GHL klijentom u kasnijoj fazi.

**Architecture:** Single-package single-process Node.js + TypeScript backend. Fastify za HTTP, BullMQ + Redis za async job queue, Postgres + Kysely za persistencju, Anthropic SDK za LLM, pure TypeScript funkcije za sanitizer. Pure moduli (sanitizer, prompt) bez I/O. Side-effectful moduli (db, llm, ghl, queue) isolated. Core orkestratori spajaju ih.

**Tech Stack:** Node.js 20+, TypeScript (ESM, strict), Fastify 4+, Kysely, pg, BullMQ, ioredis, @anthropic-ai/sdk, pino, zod, vitest, fast-check. Docker Compose za Postgres 15 + Redis 7 lokalno.

**Reference:** [docs/superpowers/specs/2026-05-09-salon-receptionist-v1-mock-design.md](../specs/2026-05-09-salon-receptionist-v1-mock-design.md)

---

## File Structure

```
salon-receptionist/
├── .env.example
├── .gitignore
├── docker-compose.yml
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── README.md
├── src/
│   ├── index.ts                       # Composition root, starts API + worker
│   ├── config.ts                      # Env loading + zod validation
│   ├── routes/
│   │   ├── webhooks-ghl-inbound.ts
│   │   ├── webhooks-ghl-resume.ts
│   │   ├── dev-simulate.ts
│   │   └── admin-salons.ts
│   ├── workers/
│   │   ├── respond.ts                 # BullMQ job handler
│   │   └── auto-resume.ts             # Recurring escalation timeout job
│   ├── core/
│   │   ├── handle-inbound.ts
│   │   ├── generate-response.ts
│   │   ├── escalate.ts
│   │   ├── sot-schema.ts              # Zod schema for Source of Truth
│   │   ├── salon-config-schema.ts     # Zod schema for salons.config
│   │   └── types.ts
│   ├── sanitizer/
│   │   ├── index.ts                   # sanitize(raw, ctx)
│   │   └── split.ts                   # splitOnSentenceBoundaries helper
│   ├── prompt/
│   │   ├── build.ts
│   │   └── tools.ts                   # Anthropic tool schema definitions
│   ├── llm/
│   │   └── client.ts                  # LlmClient interface + AnthropicLlmClient
│   ├── ghl/
│   │   ├── client.ts                  # GhlClient interface
│   │   └── mock.ts                    # MockGhlClient
│   ├── db/
│   │   ├── kysely.ts
│   │   ├── schema.ts                  # Kysely table types
│   │   ├── migrations/
│   │   │   └── 0001_initial.ts
│   │   ├── migrate.ts                 # CLI to run migrations
│   │   └── repos/
│   │       ├── salons.ts
│   │       ├── conversations.ts
│   │       ├── messages.ts
│   │       ├── events.ts
│   │       └── escalations.ts
│   ├── queue/
│   │   └── index.ts                   # BullMQ setup
│   └── lib/
│       ├── logger.ts
│       └── errors.ts
└── tests/
    ├── helpers/
    │   ├── test-db.ts                 # Per-test schema reset
    │   └── fake-llm-client.ts
    ├── unit/
    │   └── sanitizer/
    │       ├── sanitizer.spec.ts
    │       ├── property.spec.ts
    │       └── fixtures/              # ~30 input/expected pairs
    └── e2e/
        ├── 01-simple-qa.spec.ts
        ├── 02-booking-link-dedup.spec.ts
        ├── 03-escalate-tool.spec.ts
        ├── 04-auto-resume.spec.ts
        ├── 05-idempotent-and-empty.spec.ts
        └── fixtures/
            └── salon-bella.json
```

---

## Phase 1 — Korak 1: Skeleton end-to-end

### Task 1: Project initialization

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `.env.example`
- Create: `vitest.config.ts`
- Create: `README.md`

- [ ] **Step 1: Initialize git repo and create package.json**

Run:
```bash
cd c:/sm_chatbot
git init
npm init -y
```

- [ ] **Step 2: Replace package.json with the project manifest**

Write `package.json`:
```json
{
  "name": "salon-receptionist",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "migrate:up": "tsx src/db/migrate.ts up",
    "migrate:down": "tsx src/db/migrate.ts down",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:unit": "vitest run tests/unit",
    "test:e2e": "vitest run tests/e2e",
    "lint": "tsc --noEmit"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.32.0",
    "bullmq": "^5.1.0",
    "fastify": "^5.0.0",
    "ioredis": "^5.3.2",
    "kysely": "^0.27.0",
    "pg": "^8.11.0",
    "pino": "^9.0.0",
    "zod": "^3.22.0"
  },
  "devDependencies": {
    "@types/node": "^20.10.0",
    "@types/pg": "^8.10.0",
    "fast-check": "^3.15.0",
    "pino-pretty": "^11.0.0",
    "tsx": "^4.7.0",
    "typescript": "^5.3.0",
    "vitest": "^1.2.0"
  }
}
```

- [ ] **Step 3: Create tsconfig.json**

Write `tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "esModuleInterop": true,
    "strict": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "declaration": false,
    "sourceMap": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

- [ ] **Step 4: Create .gitignore**

Write `.gitignore`:
```
node_modules/
dist/
.env
.env.local
*.log
coverage/
.DS_Store
```

- [ ] **Step 5: Create .env.example**

Write `.env.example`:
```
PORT=3000
NODE_ENV=development
LOG_LEVEL=info

DATABASE_URL=postgres://salon:salon@localhost:5432/salon
REDIS_URL=redis://localhost:6379

WEBHOOK_SECRET=dev-secret-change-me
ADMIN_API_KEY=dev-admin-key-change-me

ANTHROPIC_API_KEY=
LLM_MODEL=claude-sonnet-4-5
```

- [ ] **Step 6: Create vitest.config.ts**

Write `vitest.config.ts`:
```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 30_000,
  },
});
```

- [ ] **Step 7: Create minimal README.md**

Write `README.md`:
```markdown
# Salon Receptionist V1 Mock

AI receptionist for hair salons — V1 mock phase. See [design doc](docs/superpowers/specs/2026-05-09-salon-receptionist-v1-mock-design.md).

## Dev quickstart

```bash
cp .env.example .env       # fill in ANTHROPIC_API_KEY
docker compose up -d        # postgres + redis
npm install
npm run migrate:up
npm run dev
```

Smoke test:
```bash
curl -X POST http://localhost:3000/dev/simulate-inbound \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: dev-secret-change-me" \
  -d '{"location_id":"loc_1","contact_id":"c_1","message_text":"hello"}'
```
```

- [ ] **Step 8: Install dependencies**

Run: `npm install`
Expected: dependencies install without errors.

- [ ] **Step 9: Verify TypeScript compiles**

Run: `npm run lint`
Expected: no output (no source files yet, but tsc should not error).

- [ ] **Step 10: Commit**

```bash
git add .
git commit -m "chore: initialize project skeleton"
```

---

### Task 2: Docker Compose + database migration scaffolding

**Files:**
- Create: `docker-compose.yml`
- Create: `src/lib/logger.ts`
- Create: `src/db/kysely.ts`
- Create: `src/db/schema.ts`
- Create: `src/db/migrations/0001_initial.ts`
- Create: `src/db/migrate.ts`

- [ ] **Step 1: Create docker-compose.yml**

Write `docker-compose.yml`:
```yaml
services:
  postgres:
    image: postgres:15-alpine
    environment:
      POSTGRES_USER: salon
      POSTGRES_PASSWORD: salon
      POSTGRES_DB: salon
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U salon"]
      interval: 5s
      timeout: 5s
      retries: 5

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 5s
      retries: 5

volumes:
  postgres_data:
```

- [ ] **Step 2: Start docker services**

Run: `docker compose up -d`
Expected: both services start. `docker compose ps` shows healthy.

- [ ] **Step 3: Create logger module**

Write `src/lib/logger.ts`:
```typescript
import pino from 'pino';

const isDev = process.env.NODE_ENV !== 'production';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  transport: isDev
    ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } }
    : undefined,
});
```

- [ ] **Step 4: Create Kysely connection module**

Write `src/db/kysely.ts`:
```typescript
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { Database } from './schema.js';

export function createKyselyDb(databaseUrl: string): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString: databaseUrl, max: 10 }),
    }),
  });
}

export type Db = Kysely<Database>;
```

- [ ] **Step 5: Create Kysely schema types**

Write `src/db/schema.ts`:
```typescript
import type { ColumnType, Generated } from 'kysely';

export interface Database {
  salons: SalonsTable;
  conversations: ConversationsTable;
  messages: MessagesTable;
  conversation_events: EventsTable;
  escalations: EscalationsTable;
  mock_outbound_log: MockOutboundLogTable;
  mock_contact_state: MockContactStateTable;
}

export interface SalonsTable {
  id: Generated<string>;
  display_name: string;
  ghl_location_id: string;
  ghl_pit: string;
  source_of_truth: ColumnType<unknown, string, string>;
  config: ColumnType<unknown, string, string>;
  is_active: ColumnType<boolean, boolean | undefined, boolean>;
  created_at: ColumnType<Date, never, never>;
  updated_at: ColumnType<Date, never, Date>;
}

export interface ConversationsTable {
  id: Generated<string>;
  salon_id: string;
  ghl_contact_id: string;
  ghl_conversation_id: string | null;
  client_handle: string | null;
  state: ColumnType<unknown, string, string>;
  handoff_until: ColumnType<Date | null, Date | null, Date | null>;
  last_message_at: ColumnType<Date | null, Date | null, Date | null>;
  created_at: ColumnType<Date, never, never>;
}

export interface MessagesTable {
  id: Generated<string>;
  conversation_id: string;
  direction: 'inbound' | 'outbound' | 'owner';
  channel_type: 'text' | 'image' | 'voice' | 'system';
  raw_content: ColumnType<unknown, string, string>;
  text_content: string | null;
  ai_raw_output: string | null;
  sanitize_mods: ColumnType<unknown, string | null, string | null>;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  cost_usd: string | null;
  ghl_message_id: string | null;
  created_at: ColumnType<Date, never, never>;
}

export interface EventsTable {
  id: Generated<string>;
  conversation_id: string;
  event_type: string;
  payload: ColumnType<unknown, string, string>;
  created_at: ColumnType<Date, never, never>;
}

export interface EscalationsTable {
  id: Generated<string>;
  conversation_id: string;
  reason: string;
  context_summary: string | null;
  ghl_tag_added_at: ColumnType<Date | null, Date | null, Date | null>;
  resumed_at: ColumnType<Date | null, Date | null, Date | null>;
  resumed_by: 'auto_timeout' | 'owner_manual' | null;
  created_at: ColumnType<Date, never, never>;
}

export interface MockOutboundLogTable {
  id: Generated<string>;
  salon_id: string;
  contact_id: string;
  type: string;
  message: string;
  sent_at: ColumnType<Date, never, never>;
}

export interface MockContactStateTable {
  contact_id: string;
  tags: ColumnType<unknown, string, string>;
  custom_fields: ColumnType<unknown, string, string>;
  updated_at: ColumnType<Date, never, Date>;
}
```

- [ ] **Step 6: Write initial migration**

Write `src/db/migrations/0001_initial.ts`:
```typescript
import type { Kysely } from 'kysely';
import { sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db);

  await sql`
    CREATE TABLE salons (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      display_name TEXT NOT NULL,
      ghl_location_id TEXT NOT NULL UNIQUE,
      ghl_pit TEXT NOT NULL,
      source_of_truth JSONB NOT NULL,
      config JSONB NOT NULL DEFAULT '{}',
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.execute(db);

  await sql`
    CREATE TABLE conversations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      salon_id UUID NOT NULL REFERENCES salons(id),
      ghl_contact_id TEXT NOT NULL,
      ghl_conversation_id TEXT,
      client_handle TEXT,
      state JSONB NOT NULL DEFAULT '{}',
      handoff_until TIMESTAMPTZ,
      last_message_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (salon_id, ghl_contact_id)
    )
  `.execute(db);

  await sql`CREATE INDEX idx_conv_salon_contact ON conversations(salon_id, ghl_contact_id)`.execute(db);

  await sql`
    CREATE TABLE messages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      conversation_id UUID NOT NULL REFERENCES conversations(id),
      direction TEXT NOT NULL CHECK (direction IN ('inbound','outbound','owner')),
      channel_type TEXT NOT NULL,
      raw_content JSONB NOT NULL,
      text_content TEXT,
      ai_raw_output TEXT,
      sanitize_mods JSONB,
      prompt_tokens INT,
      completion_tokens INT,
      cost_usd NUMERIC(10,6),
      ghl_message_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.execute(db);

  await sql`CREATE INDEX idx_msg_conv_time ON messages(conversation_id, created_at)`.execute(db);
  await sql`CREATE UNIQUE INDEX idx_msg_ghl_id ON messages(ghl_message_id) WHERE ghl_message_id IS NOT NULL`.execute(db);

  await sql`
    CREATE TABLE conversation_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      conversation_id UUID NOT NULL REFERENCES conversations(id),
      event_type TEXT NOT NULL,
      payload JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.execute(db);

  await sql`CREATE INDEX idx_event_conv_type_time ON conversation_events(conversation_id, event_type, created_at DESC)`.execute(db);

  await sql`
    CREATE TABLE escalations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      conversation_id UUID NOT NULL REFERENCES conversations(id),
      reason TEXT NOT NULL,
      context_summary TEXT,
      ghl_tag_added_at TIMESTAMPTZ,
      resumed_at TIMESTAMPTZ,
      resumed_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.execute(db);

  await sql`CREATE INDEX idx_esc_active ON escalations(conversation_id) WHERE resumed_at IS NULL`.execute(db);

  await sql`
    CREATE TABLE mock_outbound_log (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      salon_id UUID NOT NULL,
      contact_id TEXT NOT NULL,
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      sent_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.execute(db);

  await sql`
    CREATE TABLE mock_contact_state (
      contact_id TEXT PRIMARY KEY,
      tags JSONB NOT NULL DEFAULT '[]',
      custom_fields JSONB NOT NULL DEFAULT '{}',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS mock_contact_state CASCADE`.execute(db);
  await sql`DROP TABLE IF EXISTS mock_outbound_log CASCADE`.execute(db);
  await sql`DROP TABLE IF EXISTS escalations CASCADE`.execute(db);
  await sql`DROP TABLE IF EXISTS conversation_events CASCADE`.execute(db);
  await sql`DROP TABLE IF EXISTS messages CASCADE`.execute(db);
  await sql`DROP TABLE IF EXISTS conversations CASCADE`.execute(db);
  await sql`DROP TABLE IF EXISTS salons CASCADE`.execute(db);
}
```

- [ ] **Step 7: Write migration runner CLI**

Write `src/db/migrate.ts`:
```typescript
import 'dotenv/config';
import { Kysely, Migrator, PostgresDialect, FileMigrationProvider } from 'kysely';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { logger } from '../lib/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function run() {
  const direction = (process.argv[2] ?? 'up') as 'up' | 'down';
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    logger.error('DATABASE_URL not set');
    process.exit(1);
  }

  const db = new Kysely<unknown>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: databaseUrl }) }),
  });

  const migrator = new Migrator({
    db,
    provider: new FileMigrationProvider({
      fs,
      path,
      migrationFolder: path.resolve(__dirname, 'migrations'),
    }),
  });

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

- [ ] **Step 8: Add dotenv to dev dependencies**

Run: `npm install --save dotenv`

- [ ] **Step 9: Copy .env.example to .env**

Run: `cp .env.example .env`

- [ ] **Step 10: Run migration**

Run: `npm run migrate:up`
Expected: log line `migration ok` for `0001_initial`. Connect with `psql` to verify tables exist.

- [ ] **Step 11: Commit**

```bash
git add docker-compose.yml src/lib/logger.ts src/db/ package.json package-lock.json
git commit -m "feat: add docker compose, kysely setup, and initial migration"
```

---

### Task 3: Config + errors module

**Files:**
- Create: `src/config.ts`
- Create: `src/lib/errors.ts`
- Create: `src/core/salon-config-schema.ts`
- Create: `src/core/sot-schema.ts`

- [ ] **Step 1: Create errors module**

Write `src/lib/errors.ts`:
```typescript
export class SanitizerEmptyOutputError extends Error {
  constructor(public rawOutput: string, public modifications: string[]) {
    super('sanitizer produced empty output');
    this.name = 'SanitizerEmptyOutputError';
  }
}

export class WebhookSecretMismatchError extends Error {
  constructor() {
    super('webhook secret mismatch');
    this.name = 'WebhookSecretMismatchError';
  }
}

export class SalonNotFoundError extends Error {
  constructor(public ghlLocationId: string) {
    super(`salon not found for location ${ghlLocationId}`);
    this.name = 'SalonNotFoundError';
  }
}
```

- [ ] **Step 2: Create salon config zod schema**

Write `src/core/salon-config-schema.ts`:
```typescript
import { z } from 'zod';

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

export type SalonConfig = z.infer<typeof SalonConfigSchema>;
```

- [ ] **Step 3: Create SoT zod schema**

Write `src/core/sot-schema.ts`:
```typescript
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

- [ ] **Step 4: Create env config loader**

Write `src/config.ts`:
```typescript
import 'dotenv/config';
import { z } from 'zod';

const ConfigSchema = z.object({
  port: z.coerce.number().int().positive().default(3000),
  nodeEnv: z.enum(['development', 'test', 'production']).default('development'),
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  databaseUrl: z.string().url(),
  redisUrl: z.string().url(),
  webhookSecret: z.string().min(8),
  adminApiKey: z.string().min(8),
  anthropicApiKey: z.string().min(1),
  llmModel: z.string().default('claude-sonnet-4-5'),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(): AppConfig {
  return ConfigSchema.parse({
    port: process.env.PORT,
    nodeEnv: process.env.NODE_ENV,
    logLevel: process.env.LOG_LEVEL,
    databaseUrl: process.env.DATABASE_URL,
    redisUrl: process.env.REDIS_URL,
    webhookSecret: process.env.WEBHOOK_SECRET,
    adminApiKey: process.env.ADMIN_API_KEY,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    llmModel: process.env.LLM_MODEL,
  });
}
```

- [ ] **Step 5: Verify it compiles**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/config.ts src/lib/errors.ts src/core/
git commit -m "feat: add config, errors, and zod schemas for SoT and salon config"
```

---

### Task 4: Domain types + GhlClient interface + MockGhlClient

**Files:**
- Create: `src/core/types.ts`
- Create: `src/ghl/client.ts`
- Create: `src/ghl/mock.ts`

- [ ] **Step 1: Create domain types**

Write `src/core/types.ts`:
```typescript
import type { Sot } from './sot-schema.js';
import type { SalonConfig } from './salon-config-schema.js';

export interface Salon {
  id: string;
  displayName: string;
  ghlLocationId: string;
  ghlPit: string;
  sourceOfTruth: Sot;
  config: SalonConfig;
  isActive: boolean;
}

export interface Conversation {
  id: string;
  salonId: string;
  ghlContactId: string;
  ghlConversationId: string | null;
  clientHandle: string | null;
  state: Record<string, unknown>;
  handoffUntil: Date | null;
  lastMessageAt: Date | null;
}

export interface Message {
  id: string;
  conversationId: string;
  direction: 'inbound' | 'outbound' | 'owner';
  channelType: 'text' | 'image' | 'voice' | 'system';
  textContent: string | null;
  aiRawOutput: string | null;
  sanitizeMods: string[] | null;
  ghlMessageId: string | null;
  createdAt: Date;
}

export interface ConversationEvent {
  id: string;
  conversationId: string;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: Date;
}

export interface ConversationContext {
  conversation: Conversation;
  recentMessages: Message[];
  recentEvents: ConversationEvent[];
}
```

- [ ] **Step 2: Create GhlClient interface**

Write `src/ghl/client.ts`:
```typescript
export interface GhlClient {
  sendMessage(input: {
    contactId: string;
    type: 'IG';
    message: string;
  }): Promise<{ ghlMessageId: string }>;

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

- [ ] **Step 3: Create MockGhlClient**

Write `src/ghl/mock.ts`:
```typescript
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { Db } from '../db/kysely.js';
import { logger } from '../lib/logger.js';
import type { GhlClient } from './client.js';

export class MockGhlClient implements GhlClient {
  private getMessageStore = new Map<string, { text: string; attachments: Array<{ url: string; type: 'image' | 'audio' | 'video' }> }>();

  constructor(private db: Db) {}

  /** Test/dev helper: pre-stage a message so getMessage() can return it. */
  stageMessage(messageId: string, text: string, attachments: Array<{ url: string; type: 'image' | 'audio' | 'video' }> = []): void {
    this.getMessageStore.set(messageId, { text, attachments });
  }

  async sendMessage(input: { contactId: string; type: 'IG'; message: string }): Promise<{ ghlMessageId: string }> {
    const ghlMessageId = `mock_${randomUUID()}`;
    const salon = await this.db
      .selectFrom('salons')
      .innerJoin('conversations', 'conversations.salon_id', 'salons.id')
      .where('conversations.ghl_contact_id', '=', input.contactId)
      .select(['salons.id as salon_id'])
      .executeTakeFirst();

    await this.db
      .insertInto('mock_outbound_log')
      .values({
        salon_id: salon?.salon_id ?? '00000000-0000-0000-0000-000000000000',
        contact_id: input.contactId,
        type: input.type,
        message: input.message,
      })
      .execute();

    logger.info({ contactId: input.contactId, type: input.type, message: input.message }, '[mock-ghl] sendMessage');
    return { ghlMessageId };
  }

  async getMessage(messageId: string): Promise<{ text: string; attachments: Array<{ url: string; type: 'image' | 'audio' | 'video' }> }> {
    const staged = this.getMessageStore.get(messageId);
    if (staged) return staged;
    return { text: '', attachments: [] };
  }

  async addTag(contactId: string, tags: string[]): Promise<void> {
    await this.upsertContactState(contactId, (current) => ({
      ...current,
      tags: Array.from(new Set([...(current.tags ?? []), ...tags])),
    }));
    logger.info({ contactId, tags }, '[mock-ghl] addTag');
  }

  async removeTag(contactId: string, tags: string[]): Promise<void> {
    await this.upsertContactState(contactId, (current) => ({
      ...current,
      tags: (current.tags ?? []).filter((t: string) => !tags.includes(t)),
    }));
    logger.info({ contactId, tags }, '[mock-ghl] removeTag');
  }

  async updateCustomField(input: { contactId: string; fieldId: string; value: string | number | boolean }): Promise<void> {
    await this.upsertContactState(input.contactId, (current) => ({
      ...current,
      custom_fields: { ...(current.custom_fields ?? {}), [input.fieldId]: input.value },
    }));
    logger.info({ contactId: input.contactId, fieldId: input.fieldId, value: input.value }, '[mock-ghl] updateCustomField');
  }

  private async upsertContactState(
    contactId: string,
    mutator: (current: { tags?: string[]; custom_fields?: Record<string, unknown> }) => { tags?: string[]; custom_fields?: Record<string, unknown> },
  ): Promise<void> {
    const existing = await this.db
      .selectFrom('mock_contact_state')
      .where('contact_id', '=', contactId)
      .selectAll()
      .executeTakeFirst();

    const current = existing
      ? {
          tags: (existing.tags as string[]) ?? [],
          custom_fields: (existing.custom_fields as Record<string, unknown>) ?? {},
        }
      : { tags: [], custom_fields: {} };

    const next = mutator(current);

    await sql`
      INSERT INTO mock_contact_state (contact_id, tags, custom_fields, updated_at)
      VALUES (${contactId}, ${JSON.stringify(next.tags ?? [])}::jsonb, ${JSON.stringify(next.custom_fields ?? {})}::jsonb, now())
      ON CONFLICT (contact_id) DO UPDATE SET
        tags = EXCLUDED.tags,
        custom_fields = EXCLUDED.custom_fields,
        updated_at = now()
    `.execute(this.db);
  }
}
```

- [ ] **Step 4: Verify compiles**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/core/types.ts src/ghl/
git commit -m "feat: add domain types and MockGhlClient with in-memory + DB-backed state"
```

---

### Task 5: Stub LlmClient + stub sanitizer

**Files:**
- Create: `src/llm/client.ts`
- Create: `src/sanitizer/index.ts`

- [ ] **Step 1: Create LlmClient interface and stub implementation**

Write `src/llm/client.ts`:
```typescript
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface LlmCompleteInput {
  systemPrompt: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  tools: ToolDefinition[];
  model: string;
  maxTokens: number;
}

export interface LlmCompleteOutput {
  text: string;
  toolCalls: ToolCall[];
  usage: { inputTokens: number; outputTokens: number };
}

export interface LlmClient {
  complete(input: LlmCompleteInput): Promise<LlmCompleteOutput>;
}

/** Korak 1 stub. Replaced with AnthropicLlmClient in Korak 4. */
export class StubLlmClient implements LlmClient {
  async complete(_input: LlmCompleteInput): Promise<LlmCompleteOutput> {
    return {
      text: 'Hey hun! How can I help?',
      toolCalls: [],
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }
}
```

- [ ] **Step 2: Create stub sanitizer (passthrough)**

Write `src/sanitizer/index.ts`:
```typescript
import { SanitizerEmptyOutputError } from '../lib/errors.js';

export interface SanitizeContext {
  bookingLink: string;
  bookingLinkSentInLastN: (n: number) => Promise<boolean>;
  policy: {
    maxWordsPerMessage: number;
    maxEmojis: number;
    bookingLinkDedupWindow: number;
  };
}

export interface SanitizeResult {
  messages: string[];
  modifications: string[];
}

/** Korak 1 stub: identity passthrough. Replaced with full pipeline in Korak 2. */
export async function sanitize(raw: string, _ctx: SanitizeContext): Promise<SanitizeResult> {
  const text = raw.trim();
  if (text.length === 0) {
    throw new SanitizerEmptyOutputError(raw, []);
  }
  return { messages: [text], modifications: [] };
}
```

- [ ] **Step 3: Verify compiles**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/llm/ src/sanitizer/
git commit -m "feat: add stub LlmClient and stub sanitizer (replaced in Korak 2/4)"
```

---

### Task 6: Composition root + Fastify server skeleton

**Files:**
- Create: `src/index.ts`
- Modify (will create): `src/routes/webhooks-ghl-inbound.ts`
- Modify (will create): `src/routes/webhooks-ghl-resume.ts`
- Modify (will create): `src/routes/dev-simulate.ts`
- Modify (will create): `src/routes/admin-salons.ts`

- [ ] **Step 1: Create composition root with placeholder routes**

Write `src/index.ts`:
```typescript
import Fastify from 'fastify';
import { Redis } from 'ioredis';
import { loadConfig } from './config.js';
import { createKyselyDb } from './db/kysely.js';
import { MockGhlClient } from './ghl/mock.js';
import { StubLlmClient } from './llm/client.js';
import { logger } from './lib/logger.js';

async function main() {
  const cfg = loadConfig();
  const db = createKyselyDb(cfg.databaseUrl);
  const redis = new Redis(cfg.redisUrl);
  const llm = new StubLlmClient();
  const ghl = new MockGhlClient(db);

  const app = Fastify({ logger: false });

  app.get('/health', async () => ({ status: 'ok', ts: new Date().toISOString() }));

  const deps = { db, redis, ghl, llm, cfg } as const;
  app.decorate('deps', deps);

  // Routes wired in subsequent tasks; placeholder echo for now.
  app.post('/dev/simulate-inbound', async (request, reply) => {
    logger.info({ body: request.body }, '/dev/simulate-inbound (placeholder)');
    return reply.code(202).send({ accepted: true });
  });

  app.setErrorHandler((err, _req, reply) => {
    logger.error({ err }, 'unhandled error');
    reply.code(500).send({ error: 'internal_error' });
  });

  await app.listen({ port: cfg.port, host: '0.0.0.0' });
  logger.info({ port: cfg.port }, 'server listening');

  const shutdown = async () => {
    logger.info('shutting down');
    await app.close();
    await redis.quit();
    await db.destroy();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  logger.error({ err }, 'fatal startup error');
  process.exit(1);
});

declare module 'fastify' {
  interface FastifyInstance {
    deps: {
      db: ReturnType<typeof createKyselyDb>;
      redis: Redis;
      ghl: MockGhlClient;
      llm: StubLlmClient;
      cfg: ReturnType<typeof loadConfig>;
    };
  }
}
```

- [ ] **Step 2: Run dev server and hit health endpoint**

Run: `npm run dev` (in one terminal)
In another terminal: `curl http://localhost:3000/health`
Expected: `{"status":"ok","ts":"2026-..."}`

Stop dev server with Ctrl+C.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: add composition root and Fastify server skeleton"
```

---

### Task 7: Inbound webhook + dev-simulate routes

**Files:**
- Create: `src/routes/webhooks-ghl-inbound.ts`
- Create: `src/routes/dev-simulate.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Create inbound webhook route**

Write `src/routes/webhooks-ghl-inbound.ts`:
```typescript
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { logger } from '../lib/logger.js';

const InboundPayloadSchema = z.object({
  location_id: z.string(),
  contact_id: z.string(),
  contact_handle: z.string().optional().nullable(),
  message_id: z.string().optional().nullable(),
  message_text: z.string().optional().nullable(),
  attachments: z.unknown().optional(),
  conversation_id: z.string().optional().nullable(),
  timestamp: z.string().optional().nullable(),
});

export type InboundPayload = z.infer<typeof InboundPayloadSchema>;

export async function inboundWebhookRoute(app: FastifyInstance): Promise<void> {
  app.post('/webhooks/ghl/inbound', async (request, reply) => {
    const secret = request.headers['x-webhook-secret'];
    if (secret !== app.deps.cfg.webhookSecret) {
      logger.warn('webhook secret mismatch');
      return reply.code(401).send({ error: 'unauthorized' });
    }

    const parsed = InboundPayloadSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_payload', details: parsed.error.flatten() });
    }

    reply.code(200).send({ accepted: true });

    setImmediate(() => {
      logger.info({ payload: parsed.data }, '[stub] inbound received (handle-inbound wired in Task 8)');
    });
  });
}
```

- [ ] **Step 2: Create dev-simulate route**

Write `src/routes/dev-simulate.ts`:
```typescript
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { logger } from '../lib/logger.js';

const DevPayloadSchema = z.object({
  location_id: z.string().default('loc_dev'),
  contact_id: z.string().default('contact_dev'),
  contact_handle: z.string().optional(),
  message_id: z.string().optional(),
  message_text: z.string().min(1),
  stage_get_message: z.boolean().default(false),
});

export async function devSimulateRoute(app: FastifyInstance): Promise<void> {
  if (app.deps.cfg.nodeEnv === 'production') {
    return;
  }

  app.post('/dev/simulate-inbound', async (request, reply) => {
    const parsed = DevPayloadSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_payload', details: parsed.error.flatten() });
    }

    const data = parsed.data;
    const messageId = data.message_id ?? `dev_msg_${Date.now()}`;

    if (data.stage_get_message) {
      app.deps.ghl.stageMessage(messageId, data.message_text);
    }

    reply.code(202).send({ accepted: true, message_id: messageId });

    setImmediate(() => {
      logger.info(
        { payload: { ...data, message_id: messageId } },
        '[stub] dev simulate received (handle-inbound wired in Task 8)',
      );
    });
  });
}
```

- [ ] **Step 3: Replace placeholder in index.ts with route registrations**

Modify `src/index.ts` — replace the placeholder route block:

Replace:
```typescript
  // Routes wired in subsequent tasks; placeholder echo for now.
  app.post('/dev/simulate-inbound', async (request, reply) => {
    logger.info({ body: request.body }, '/dev/simulate-inbound (placeholder)');
    return reply.code(202).send({ accepted: true });
  });
```

With:
```typescript
  await app.register(inboundWebhookRoute);
  await app.register(devSimulateRoute);
```

And add imports at top:
```typescript
import { inboundWebhookRoute } from './routes/webhooks-ghl-inbound.js';
import { devSimulateRoute } from './routes/dev-simulate.js';
```

- [ ] **Step 4: Run dev server and test webhook**

Run: `npm run dev`
In another terminal:
```bash
curl -X POST http://localhost:3000/webhooks/ghl/inbound \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: dev-secret-change-me" \
  -d '{"location_id":"loc_1","contact_id":"c_1","message_text":"hi"}'
```
Expected: `{"accepted":true}` and server log shows the payload.

Then test wrong secret:
```bash
curl -X POST http://localhost:3000/webhooks/ghl/inbound \
  -H "X-Webhook-Secret: wrong" \
  -H "Content-Type: application/json" \
  -d '{"location_id":"x","contact_id":"y","message_text":"z"}'
```
Expected: `{"error":"unauthorized"}` with 401.

Stop server.

- [ ] **Step 5: Commit**

```bash
git add src/routes/ src/index.ts
git commit -m "feat: add inbound webhook and dev-simulate routes with secret verification"
```

---

### Task 8: Repos for salons + conversations + messages + events (minimal subset for Korak 1)

**Files:**
- Create: `src/db/repos/salons.ts`
- Create: `src/db/repos/conversations.ts`
- Create: `src/db/repos/messages.ts`
- Create: `src/db/repos/events.ts`

- [ ] **Step 1: Create salons repo**

Write `src/db/repos/salons.ts`:
```typescript
import type { Db } from '../kysely.js';
import type { Salon } from '../../core/types.js';
import { SotSchema } from '../../core/sot-schema.js';
import { SalonConfigSchema } from '../../core/salon-config-schema.js';

export async function findByLocationId(db: Db, ghlLocationId: string): Promise<Salon | null> {
  const row = await db
    .selectFrom('salons')
    .where('ghl_location_id', '=', ghlLocationId)
    .where('is_active', '=', true)
    .selectAll()
    .executeTakeFirst();
  if (!row) return null;
  return rowToSalon(row);
}

export async function findById(db: Db, id: string): Promise<Salon | null> {
  const row = await db
    .selectFrom('salons')
    .where('id', '=', id)
    .selectAll()
    .executeTakeFirst();
  if (!row) return null;
  return rowToSalon(row);
}

export async function create(db: Db, input: {
  displayName: string;
  ghlLocationId: string;
  ghlPit: string;
  sourceOfTruth: unknown;
  config: unknown;
}): Promise<Salon> {
  const sot = SotSchema.parse(input.sourceOfTruth);
  const cfg = SalonConfigSchema.parse(input.config);
  const row = await db
    .insertInto('salons')
    .values({
      display_name: input.displayName,
      ghl_location_id: input.ghlLocationId,
      ghl_pit: input.ghlPit,
      source_of_truth: JSON.stringify(sot),
      config: JSON.stringify(cfg),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return rowToSalon(row);
}

function rowToSalon(row: {
  id: string;
  display_name: string;
  ghl_location_id: string;
  ghl_pit: string;
  source_of_truth: unknown;
  config: unknown;
  is_active: boolean;
}): Salon {
  return {
    id: row.id,
    displayName: row.display_name,
    ghlLocationId: row.ghl_location_id,
    ghlPit: row.ghl_pit,
    sourceOfTruth: SotSchema.parse(row.source_of_truth),
    config: SalonConfigSchema.parse(row.config),
    isActive: row.is_active,
  };
}
```

- [ ] **Step 2: Create conversations repo**

Write `src/db/repos/conversations.ts`:
```typescript
import { sql } from 'kysely';
import type { Db } from '../kysely.js';
import type { Conversation, ConversationContext, Message, ConversationEvent } from '../../core/types.js';

export async function findOrCreate(
  db: Db,
  salonId: string,
  ghlContactId: string,
  clientHandle: string | null,
): Promise<Conversation> {
  const existing = await db
    .selectFrom('conversations')
    .where('salon_id', '=', salonId)
    .where('ghl_contact_id', '=', ghlContactId)
    .selectAll()
    .executeTakeFirst();
  if (existing) return rowToConversation(existing);

  const inserted = await db
    .insertInto('conversations')
    .values({
      salon_id: salonId,
      ghl_contact_id: ghlContactId,
      client_handle: clientHandle,
      state: '{}',
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return rowToConversation(inserted);
}

export async function setHandoffUntil(db: Db, id: string, until: Date | null): Promise<void> {
  await db.updateTable('conversations').set({ handoff_until: until }).where('id', '=', id).execute();
}

export async function touchLastMessageAt(db: Db, id: string, at: Date): Promise<void> {
  await db.updateTable('conversations').set({ last_message_at: at }).where('id', '=', id).execute();
}

export async function mergeState(db: Db, id: string, patch: Record<string, unknown>): Promise<void> {
  await sql`
    UPDATE conversations
    SET state = state || ${JSON.stringify(patch)}::jsonb
    WHERE id = ${id}
  `.execute(db);
}

export async function loadContext(db: Db, conversationId: string, recentMessageLimit: number): Promise<ConversationContext> {
  const conv = await db
    .selectFrom('conversations')
    .where('id', '=', conversationId)
    .selectAll()
    .executeTakeFirstOrThrow();

  const messages = await db
    .selectFrom('messages')
    .where('conversation_id', '=', conversationId)
    .orderBy('created_at', 'desc')
    .limit(recentMessageLimit)
    .selectAll()
    .execute();

  const events = await db
    .selectFrom('conversation_events')
    .where('conversation_id', '=', conversationId)
    .orderBy('created_at', 'desc')
    .limit(50)
    .selectAll()
    .execute();

  return {
    conversation: rowToConversation(conv),
    recentMessages: messages.reverse().map(rowToMessage),
    recentEvents: events.map(rowToEvent),
  };
}

function rowToConversation(row: {
  id: string;
  salon_id: string;
  ghl_contact_id: string;
  ghl_conversation_id: string | null;
  client_handle: string | null;
  state: unknown;
  handoff_until: Date | null;
  last_message_at: Date | null;
}): Conversation {
  return {
    id: row.id,
    salonId: row.salon_id,
    ghlContactId: row.ghl_contact_id,
    ghlConversationId: row.ghl_conversation_id,
    clientHandle: row.client_handle,
    state: (row.state as Record<string, unknown>) ?? {},
    handoffUntil: row.handoff_until,
    lastMessageAt: row.last_message_at,
  };
}

function rowToMessage(row: {
  id: string;
  conversation_id: string;
  direction: 'inbound' | 'outbound' | 'owner';
  channel_type: 'text' | 'image' | 'voice' | 'system';
  text_content: string | null;
  ai_raw_output: string | null;
  sanitize_mods: unknown;
  ghl_message_id: string | null;
  created_at: Date;
}): Message {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    direction: row.direction,
    channelType: row.channel_type,
    textContent: row.text_content,
    aiRawOutput: row.ai_raw_output,
    sanitizeMods: (row.sanitize_mods as string[] | null) ?? null,
    ghlMessageId: row.ghl_message_id,
    createdAt: row.created_at,
  };
}

function rowToEvent(row: { id: string; conversation_id: string; event_type: string; payload: unknown; created_at: Date }): ConversationEvent {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    eventType: row.event_type,
    payload: (row.payload as Record<string, unknown>) ?? {},
    createdAt: row.created_at,
  };
}
```

- [ ] **Step 3: Create messages repo**

Write `src/db/repos/messages.ts`:
```typescript
import type { Db } from '../kysely.js';

export interface InsertInboundInput {
  conversationId: string;
  channelType: 'text' | 'image' | 'voice';
  rawContent: unknown;
  textContent: string;
  ghlMessageId: string | null;
}

export async function insertInbound(db: Db, input: InsertInboundInput): Promise<{ id: string } | null> {
  if (input.ghlMessageId) {
    const existing = await db
      .selectFrom('messages')
      .where('ghl_message_id', '=', input.ghlMessageId)
      .select('id')
      .executeTakeFirst();
    if (existing) return null;
  }

  const row = await db
    .insertInto('messages')
    .values({
      conversation_id: input.conversationId,
      direction: 'inbound',
      channel_type: input.channelType,
      raw_content: JSON.stringify(input.rawContent),
      text_content: input.textContent,
      ghl_message_id: input.ghlMessageId,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return { id: row.id };
}

export interface InsertOutboundInput {
  conversationId: string;
  textContent: string;
  aiRawOutput: string;
  sanitizeMods: string[];
  promptTokens: number;
  completionTokens: number;
  costUsd: number | null;
  ghlMessageId: string;
}

export async function insertOutbound(db: Db, input: InsertOutboundInput): Promise<{ id: string }> {
  const row = await db
    .insertInto('messages')
    .values({
      conversation_id: input.conversationId,
      direction: 'outbound',
      channel_type: 'text',
      raw_content: JSON.stringify({ text: input.textContent }),
      text_content: input.textContent,
      ai_raw_output: input.aiRawOutput,
      sanitize_mods: JSON.stringify(input.sanitizeMods),
      prompt_tokens: input.promptTokens,
      completion_tokens: input.completionTokens,
      cost_usd: input.costUsd?.toFixed(6) ?? null,
      ghl_message_id: input.ghlMessageId,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return { id: row.id };
}
```

- [ ] **Step 4: Create events repo**

Write `src/db/repos/events.ts`:
```typescript
import type { Db } from '../kysely.js';

export async function insert(db: Db, conversationId: string, eventType: string, payload: Record<string, unknown> = {}): Promise<void> {
  await db
    .insertInto('conversation_events')
    .values({
      conversation_id: conversationId,
      event_type: eventType,
      payload: JSON.stringify(payload),
    })
    .execute();
}

export async function recentBookingLinkSent(db: Db, conversationId: string, withinLastN: number): Promise<boolean> {
  const recent = await db
    .selectFrom('conversation_events')
    .where('conversation_id', '=', conversationId)
    .where('event_type', '=', 'booking_link_sent')
    .orderBy('created_at', 'desc')
    .limit(withinLastN)
    .select('id')
    .execute();
  return recent.length > 0;
}
```

- [ ] **Step 5: Verify compiles**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/db/repos/
git commit -m "feat: add salons, conversations, messages, events repos"
```

---

### Task 9: handle-inbound stub flow + admin-salons + manual smoke

**Files:**
- Create: `src/core/handle-inbound.ts`
- Create: `src/routes/admin-salons.ts`
- Modify: `src/index.ts`
- Modify: `src/routes/dev-simulate.ts`
- Modify: `src/routes/webhooks-ghl-inbound.ts`

- [ ] **Step 1: Create handle-inbound core function (sync stub flow)**

Write `src/core/handle-inbound.ts`:
```typescript
import type { Db } from '../db/kysely.js';
import type { GhlClient } from '../ghl/client.js';
import type { LlmClient } from '../llm/client.js';
import * as salonsRepo from '../db/repos/salons.js';
import * as conversationsRepo from '../db/repos/conversations.js';
import * as messagesRepo from '../db/repos/messages.js';
import * as eventsRepo from '../db/repos/events.js';
import { sanitize } from '../sanitizer/index.js';
import { logger } from '../lib/logger.js';

export interface HandleInboundInput {
  locationId: string;
  contactId: string;
  contactHandle: string | null;
  messageId: string | null;
  messageText: string | null;
  rawPayload: unknown;
}

export interface HandleInboundDeps {
  db: Db;
  ghl: GhlClient;
  llm: LlmClient;
}

export async function handleInbound(deps: HandleInboundDeps, input: HandleInboundInput): Promise<void> {
  const salon = await salonsRepo.findByLocationId(deps.db, input.locationId);
  if (!salon) {
    logger.info({ locationId: input.locationId }, 'salon not found for inbound; dropping');
    return;
  }

  let textContent = input.messageText ?? '';
  if (!textContent && input.messageId) {
    const fetched = await deps.ghl.getMessage(input.messageId);
    textContent = fetched.text;
  }
  if (!textContent) {
    logger.warn({ locationId: input.locationId, contactId: input.contactId }, 'inbound has no text content; dropping');
    return;
  }

  const conversation = await conversationsRepo.findOrCreate(deps.db, salon.id, input.contactId, input.contactHandle);

  const inserted = await messagesRepo.insertInbound(deps.db, {
    conversationId: conversation.id,
    channelType: 'text',
    rawContent: input.rawPayload,
    textContent,
    ghlMessageId: input.messageId,
  });
  if (!inserted) {
    logger.debug({ messageId: input.messageId }, 'idempotent duplicate; skipping');
    return;
  }

  await conversationsRepo.touchLastMessageAt(deps.db, conversation.id, new Date());

  if (conversation.handoffUntil && conversation.handoffUntil > new Date()) {
    logger.info({ conversationId: conversation.id }, 'handoff active; bot paused');
    return;
  }

  // Korak 1: synchronous stub respond (replaced with BullMQ in Korak 5).
  const llmResult = await deps.llm.complete({
    systemPrompt: 'You are a hair salon receptionist. Reply briefly.',
    messages: [{ role: 'user', content: textContent }],
    tools: [],
    model: salon.config.llm_model,
    maxTokens: 256,
  });

  const sanitized = await sanitize(llmResult.text, {
    bookingLink: salon.sourceOfTruth.salon.booking_link,
    bookingLinkSentInLastN: (n) => eventsRepo.recentBookingLinkSent(deps.db, conversation.id, n),
    policy: {
      maxWordsPerMessage: salon.config.max_words_per_message,
      maxEmojis: salon.config.max_emojis,
      bookingLinkDedupWindow: salon.config.booking_link_dedup_window,
    },
  });

  for (const message of sanitized.messages) {
    const sent = await deps.ghl.sendMessage({ contactId: input.contactId, type: 'IG', message });
    await messagesRepo.insertOutbound(deps.db, {
      conversationId: conversation.id,
      textContent: message,
      aiRawOutput: llmResult.text,
      sanitizeMods: sanitized.modifications,
      promptTokens: llmResult.usage.inputTokens,
      completionTokens: llmResult.usage.outputTokens,
      costUsd: null,
      ghlMessageId: sent.ghlMessageId,
    });
  }
}
```

- [ ] **Step 2: Create admin salons route**

Write `src/routes/admin-salons.ts`:
```typescript
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as salonsRepo from '../db/repos/salons.js';
import { SotSchema } from '../core/sot-schema.js';
import { SalonConfigSchema } from '../core/salon-config-schema.js';

const CreateSalonBodySchema = z.object({
  display_name: z.string().min(1),
  ghl_location_id: z.string().min(1),
  ghl_pit: z.string().min(1),
  source_of_truth: SotSchema,
  config: SalonConfigSchema,
});

export async function adminSalonsRoute(app: FastifyInstance): Promise<void> {
  app.post('/admin/salons', async (request, reply) => {
    const auth = request.headers['authorization'];
    if (auth !== `Bearer ${app.deps.cfg.adminApiKey}`) {
      return reply.code(401).send({ error: 'unauthorized' });
    }

    const parsed = CreateSalonBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_payload', details: parsed.error.flatten() });
    }

    const salon = await salonsRepo.create(app.deps.db, {
      displayName: parsed.data.display_name,
      ghlLocationId: parsed.data.ghl_location_id,
      ghlPit: parsed.data.ghl_pit,
      sourceOfTruth: parsed.data.source_of_truth,
      config: parsed.data.config,
    });

    return reply.code(201).send({ id: salon.id });
  });
}
```

- [ ] **Step 3: Wire handle-inbound into webhook routes**

Modify `src/routes/webhooks-ghl-inbound.ts` — replace `setImmediate` block:

Replace:
```typescript
    setImmediate(() => {
      logger.info({ payload: parsed.data }, '[stub] inbound received (handle-inbound wired in Task 8)');
    });
```

With:
```typescript
    setImmediate(async () => {
      try {
        await handleInbound(
          { db: app.deps.db, ghl: app.deps.ghl, llm: app.deps.llm },
          {
            locationId: parsed.data.location_id,
            contactId: parsed.data.contact_id,
            contactHandle: parsed.data.contact_handle ?? null,
            messageId: parsed.data.message_id ?? null,
            messageText: parsed.data.message_text ?? null,
            rawPayload: parsed.data,
          },
        );
      } catch (err) {
        logger.error({ err }, 'handle-inbound failed');
      }
    });
```

Add import:
```typescript
import { handleInbound } from '../core/handle-inbound.js';
```

- [ ] **Step 4: Wire handle-inbound into dev-simulate**

Modify `src/routes/dev-simulate.ts` — replace the `setImmediate` block similarly:

Replace:
```typescript
    setImmediate(() => {
      logger.info(
        { payload: { ...data, message_id: messageId } },
        '[stub] dev simulate received (handle-inbound wired in Task 8)',
      );
    });
```

With:
```typescript
    setImmediate(async () => {
      try {
        await handleInbound(
          { db: app.deps.db, ghl: app.deps.ghl, llm: app.deps.llm },
          {
            locationId: data.location_id,
            contactId: data.contact_id,
            contactHandle: data.contact_handle ?? null,
            messageId,
            messageText: data.stage_get_message ? null : data.message_text,
            rawPayload: data,
          },
        );
      } catch (err) {
        logger.error({ err }, 'dev simulate handle-inbound failed');
      }
    });
```

Add import:
```typescript
import { handleInbound } from '../core/handle-inbound.js';
```

- [ ] **Step 5: Register admin route in index.ts**

Modify `src/index.ts` — add registration after dev-simulate:

After:
```typescript
  await app.register(devSimulateRoute);
```

Add:
```typescript
  await app.register(adminSalonsRoute);
```

And import:
```typescript
import { adminSalonsRoute } from './routes/admin-salons.js';
```

- [ ] **Step 6: Manual smoke test**

Start server: `npm run dev`

Create salon (use real custom field IDs as placeholders for mock):
```bash
curl -X POST http://localhost:3000/admin/salons \
  -H "Authorization: Bearer dev-admin-key-change-me" \
  -H "Content-Type: application/json" \
  -d '{
    "display_name": "Bella Hair Studio",
    "ghl_location_id": "loc_bella",
    "ghl_pit": "mock-pit-bella",
    "source_of_truth": {
      "salon": {
        "name": "Bella Hair Studio",
        "owner_first_name": "Sarah",
        "location": "Toronto, ON",
        "timezone": "America/Toronto",
        "hours": {"mon":"closed","tue":"10:00-19:00"},
        "booking_link": "https://bellahair.example.com/book"
      },
      "stylists": [{"name":"Sarah","specialties":["balayage"]}],
      "services": [{"name":"Balayage","price_range":{"min":250,"max":400,"currency":"CAD"},"requires_consultation":true}],
      "voice": {"tone_notes":"Warm, casual"}
    },
    "config": {
      "ghl_custom_field_ids": {
        "needs_owner_attention": "field_needs_attn",
        "bot_paused_until": "field_paused",
        "last_escalation_reason": "field_reason"
      }
    }
  }'
```
Expected: `{"id":"<uuid>"}`

Then simulate inbound:
```bash
curl -X POST http://localhost:3000/dev/simulate-inbound \
  -H "Content-Type: application/json" \
  -d '{"location_id":"loc_bella","contact_id":"contact_test_1","message_text":"hi do you do balayage?"}'
```
Expected: `{"accepted":true,"message_id":"dev_msg_..."}`

Verify in Postgres:
```bash
docker exec -it $(docker compose ps -q postgres) psql -U salon -d salon -c "SELECT direction, text_content FROM messages ORDER BY created_at"
```
Expected: 2 rows — inbound `"hi do you do balayage?"` and outbound `"Hey hun! How can I help?"` (the stub LLM response).

Verify mock outbound log:
```bash
docker exec -it $(docker compose ps -q postgres) psql -U salon -d salon -c "SELECT * FROM mock_outbound_log"
```
Expected: 1 row with the stub response.

Stop server.

- [ ] **Step 7: Commit**

```bash
git add src/core/handle-inbound.ts src/routes/admin-salons.ts src/index.ts src/routes/webhooks-ghl-inbound.ts src/routes/dev-simulate.ts
git commit -m "feat: wire handle-inbound end-to-end with stub LLM and sanitizer (Korak 1 complete)"
```

---

## Phase 2 — Korak 2: Real sanitizer

### Task 10: Sanitizer — forbidden char scrub + emoji cap (TDD)

**Files:**
- Create: `tests/unit/sanitizer/sanitizer.spec.ts`
- Modify: `src/sanitizer/index.ts`

- [ ] **Step 1: Write failing test for forbidden char scrub**

Write `tests/unit/sanitizer/sanitizer.spec.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { sanitize } from '../../../src/sanitizer/index.js';

const baseCtx = {
  bookingLink: 'https://example.com/book',
  bookingLinkSentInLastN: async () => false,
  policy: { maxWordsPerMessage: 40, maxEmojis: 2, bookingLinkDedupWindow: 3 },
};

describe('sanitizer — forbidden chars', () => {
  it('replaces em-dash with hyphen', async () => {
    const result = await sanitize('Hi there — how are you?', baseCtx);
    expect(result.messages[0]).not.toContain('—');
    expect(result.modifications).toContain('forbidden_chars_scrubbed');
  });

  it('replaces en-dash with hyphen', async () => {
    const result = await sanitize('Open 9–5 today', baseCtx);
    expect(result.messages[0]).not.toContain('–');
    expect(result.modifications).toContain('forbidden_chars_scrubbed');
  });

  it('removes ellipsis', async () => {
    const result = await sanitize('So… that works', baseCtx);
    expect(result.messages[0]).not.toContain('…');
  });

  it('replaces semicolons with comma', async () => {
    const result = await sanitize('First; second', baseCtx);
    expect(result.messages[0]).not.toContain(';');
    expect(result.messages[0]).toContain(',');
  });
});

describe('sanitizer — emoji cap', () => {
  it('keeps two emojis, drops the rest', async () => {
    const result = await sanitize('Hi 💇‍♀️ love 💖 it 🎉 yay 🌟', baseCtx);
    const emojiCount = [...result.messages[0].matchAll(/\p{Extended_Pictographic}/gu)].length;
    expect(emojiCount).toBeLessThanOrEqual(2);
    expect(result.modifications).toContain('emojis_capped');
  });

  it('does not modify text below cap', async () => {
    const result = await sanitize('Hi 💇‍♀️ love it', baseCtx);
    expect(result.modifications).not.toContain('emojis_capped');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- sanitizer.spec.ts`
Expected: FAIL — stub passthrough doesn't actually scrub.

- [ ] **Step 3: Implement forbidden char + emoji logic**

Replace `src/sanitizer/index.ts` content with:
```typescript
import { SanitizerEmptyOutputError } from '../lib/errors.js';

export interface SanitizeContext {
  bookingLink: string;
  bookingLinkSentInLastN: (n: number) => Promise<boolean>;
  policy: {
    maxWordsPerMessage: number;
    maxEmojis: number;
    bookingLinkDedupWindow: number;
  };
}

export interface SanitizeResult {
  messages: string[];
  modifications: string[];
}

export async function sanitize(raw: string, ctx: SanitizeContext): Promise<SanitizeResult> {
  const mods: string[] = [];
  let text = raw.trim();

  const beforeScrub = text;
  text = text
    .replace(/[—–]/g, '-')
    .replace(/[…]/g, '')
    .replace(/;/g, ',')
    .replace(/\s+/g, ' ')
    .trim();
  if (text !== beforeScrub) mods.push('forbidden_chars_scrubbed');

  const emojiRe = /\p{Extended_Pictographic}/gu;
  const emojiMatches = [...text.matchAll(emojiRe)];
  if (emojiMatches.length > ctx.policy.maxEmojis) {
    let kept = 0;
    text = text.replace(emojiRe, (m) => (kept++ < ctx.policy.maxEmojis ? m : ''));
    text = text.replace(/\s+/g, ' ').trim();
    mods.push('emojis_capped');
  }

  if (text.length === 0) {
    throw new SanitizerEmptyOutputError(raw, mods);
  }

  return { messages: [text], modifications: mods };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -- sanitizer.spec.ts`
Expected: PASS for all forbidden-char + emoji tests.

- [ ] **Step 5: Commit**

```bash
git add src/sanitizer/index.ts tests/unit/sanitizer/sanitizer.spec.ts
git commit -m "feat: sanitizer forbidden char scrub and emoji cap"
```

---

### Task 11: Sanitizer — link extraction + dedup (TDD)

**Files:**
- Modify: `tests/unit/sanitizer/sanitizer.spec.ts`
- Modify: `src/sanitizer/index.ts`

- [ ] **Step 1: Append failing tests for links**

Append to `tests/unit/sanitizer/sanitizer.spec.ts`:
```typescript
describe('sanitizer — links', () => {
  it('keeps booking link when multiple links present', async () => {
    const result = await sanitize(
      'Check https://example.com/book or https://other.com',
      baseCtx,
    );
    expect(result.messages[0]).toContain('https://example.com/book');
    expect(result.messages[0]).not.toContain('https://other.com');
    expect(result.modifications).toContain('extra_links_stripped');
  });

  it('keeps first link when no booking link present', async () => {
    const result = await sanitize('See https://a.com and https://b.com', baseCtx);
    expect(result.messages[0]).toContain('https://a.com');
    expect(result.messages[0]).not.toContain('https://b.com');
  });

  it('removes booking link if recently sent', async () => {
    const result = await sanitize('Book here https://example.com/book today', {
      ...baseCtx,
      bookingLinkSentInLastN: async () => true,
    });
    expect(result.messages[0]).not.toContain('https://example.com/book');
    expect(result.modifications).toContain('booking_link_deduplicated');
  });

  it('keeps booking link when not recently sent', async () => {
    const result = await sanitize('Book here https://example.com/book today', baseCtx);
    expect(result.messages[0]).toContain('https://example.com/book');
    expect(result.modifications).not.toContain('booking_link_deduplicated');
  });
});
```

- [ ] **Step 2: Run tests to verify failures**

Run: `npm run test:unit -- sanitizer.spec.ts`
Expected: FAIL on link tests.

- [ ] **Step 3: Add link logic to sanitizer**

Modify `src/sanitizer/index.ts` — between forbidden char block and emoji cap, add:

After:
```typescript
  if (text !== beforeScrub) mods.push('forbidden_chars_scrubbed');
```

Insert:
```typescript
  const linkRe = /https?:\/\/\S+/g;
  const links = [...text.matchAll(linkRe)].map((m) => m[0]);
  if (links.length > 1) {
    const keep = links.find((l) => l.includes(ctx.bookingLink)) ?? links[0];
    for (const link of links) {
      if (link !== keep) text = text.replace(link, '');
    }
    text = text.replace(/\s+/g, ' ').trim();
    mods.push('extra_links_stripped');
  }

  if (text.includes(ctx.bookingLink)) {
    if (await ctx.bookingLinkSentInLastN(ctx.policy.bookingLinkDedupWindow)) {
      text = text.replace(ctx.bookingLink, '').replace(/\s+/g, ' ').trim();
      mods.push('booking_link_deduplicated');
    }
  }
```

- [ ] **Step 4: Run tests**

Run: `npm run test:unit -- sanitizer.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sanitizer/index.ts tests/unit/sanitizer/sanitizer.spec.ts
git commit -m "feat: sanitizer link cap and booking link dedup"
```

---

### Task 12: Sanitizer — word count split + sentence boundary helper (TDD)

**Files:**
- Create: `src/sanitizer/split.ts`
- Modify: `tests/unit/sanitizer/sanitizer.spec.ts`
- Modify: `src/sanitizer/index.ts`

- [ ] **Step 1: Write failing tests for split**

Append to `tests/unit/sanitizer/sanitizer.spec.ts`:
```typescript
describe('sanitizer — word count split', () => {
  it('keeps single message when under cap', async () => {
    const result = await sanitize('Short reply', baseCtx);
    expect(result.messages).toHaveLength(1);
    expect(result.modifications).not.toContain('split_into_multiple');
  });

  it('splits into max two messages on sentence boundary when over cap', async () => {
    const long =
      'Hi there I would love to help you with that color appointment. ' +
      'We do balayage and it usually takes about three hours. ' +
      'Want me to send you the booking link so you can pick a time that works? ' +
      'Sarah is the best for that service and she is around all week long.';
    const result = await sanitize(long, baseCtx);
    expect(result.messages.length).toBeGreaterThanOrEqual(1);
    expect(result.messages.length).toBeLessThanOrEqual(2);
    for (const m of result.messages) {
      expect(m.split(/\s+/).length).toBeLessThanOrEqual(40);
    }
    expect(result.modifications).toContain('split_into_multiple');
  });
});
```

- [ ] **Step 2: Run tests to verify failures**

Run: `npm run test:unit -- sanitizer.spec.ts`
Expected: FAIL on split tests.

- [ ] **Step 3: Implement sentence boundary splitter**

Write `src/sanitizer/split.ts`:
```typescript
export function splitOnSentenceBoundaries(text: string, maxWordsPerMessage: number, maxMessages: number): string[] {
  const sentences = text.match(/[^.!?]+[.!?]+|\S[^.!?]*$/g)?.map((s) => s.trim()).filter(Boolean) ?? [text];
  const messages: string[] = [];
  let current = '';

  for (const sentence of sentences) {
    if (messages.length >= maxMessages) break;
    const candidate = current ? `${current} ${sentence}` : sentence;
    if (candidate.split(/\s+/).length <= maxWordsPerMessage) {
      current = candidate;
    } else {
      if (current) {
        messages.push(current.trim());
        current = '';
      }
      if (messages.length >= maxMessages) break;
      const sentenceWords = sentence.split(/\s+/);
      if (sentenceWords.length <= maxWordsPerMessage) {
        current = sentence;
      } else {
        const truncated = sentenceWords.slice(0, maxWordsPerMessage).join(' ');
        messages.push(truncated);
        current = '';
      }
    }
  }
  if (current && messages.length < maxMessages) messages.push(current.trim());
  return messages.slice(0, maxMessages);
}
```

- [ ] **Step 4: Wire splitter into sanitize**

Modify `src/sanitizer/index.ts`:

After the booking-link-dedup block but BEFORE the empty check, replace the section that returns `[text]` with:

Find this block:
```typescript
  if (text.length === 0) {
    throw new SanitizerEmptyOutputError(raw, mods);
  }

  return { messages: [text], modifications: mods };
}
```

Replace with:
```typescript
  const words = text.split(/\s+/).filter(Boolean);
  let messages: string[];
  if (words.length <= ctx.policy.maxWordsPerMessage) {
    messages = [text];
  } else {
    messages = splitOnSentenceBoundaries(text, ctx.policy.maxWordsPerMessage, 2);
    mods.push('split_into_multiple');
  }

  messages = messages.map((m) => m.trim()).filter(Boolean);
  if (messages.length === 0) {
    throw new SanitizerEmptyOutputError(raw, mods);
  }

  return { messages, modifications: mods };
}
```

Add import at top:
```typescript
import { splitOnSentenceBoundaries } from './split.js';
```

- [ ] **Step 5: Run all sanitizer tests**

Run: `npm run test:unit -- sanitizer.spec.ts`
Expected: PASS for all tests.

- [ ] **Step 6: Commit**

```bash
git add src/sanitizer/ tests/unit/sanitizer/sanitizer.spec.ts
git commit -m "feat: sanitizer word count split with sentence boundary helper"
```

---

### Task 13: Sanitizer — fixture corpus

**Files:**
- Create: `tests/unit/sanitizer/fixtures/*.input.txt`, `*.expected.json`
- Create: `tests/unit/sanitizer/fixtures.spec.ts`

- [ ] **Step 1: Create fixtures directory with 6 representative pairs**

Create `tests/unit/sanitizer/fixtures/01-emdash.input.txt`:
```
Hey hun — yes we do balayage!
```

Create `tests/unit/sanitizer/fixtures/01-emdash.expected.json`:
```json
{
  "messages": ["Hey hun - yes we do balayage!"],
  "modifications": ["forbidden_chars_scrubbed"]
}
```

Create `tests/unit/sanitizer/fixtures/02-multilinks.input.txt`:
```
Visit https://example.com/book or our IG https://instagram.com/bella
```

Create `tests/unit/sanitizer/fixtures/02-multilinks.expected.json`:
```json
{
  "messages": ["Visit https://example.com/book or our IG"],
  "modifications": ["extra_links_stripped"]
}
```

Create `tests/unit/sanitizer/fixtures/03-emoji-overflow.input.txt`:
```
Yay 🎉 love 💖 amazing 🌟 perfect 💇‍♀️ done ✨
```

Create `tests/unit/sanitizer/fixtures/03-emoji-overflow.expected.json`:
```json
{
  "messages": ["Yay 🎉 love 💖 amazing perfect done"],
  "modifications": ["emojis_capped"]
}
```

Create `tests/unit/sanitizer/fixtures/04-clean-passthrough.input.txt`:
```
Sure, want to come in Tuesday?
```

Create `tests/unit/sanitizer/fixtures/04-clean-passthrough.expected.json`:
```json
{
  "messages": ["Sure, want to come in Tuesday?"],
  "modifications": []
}
```

Create `tests/unit/sanitizer/fixtures/05-semicolon.input.txt`:
```
First option; second option
```

Create `tests/unit/sanitizer/fixtures/05-semicolon.expected.json`:
```json
{
  "messages": ["First option, second option"],
  "modifications": ["forbidden_chars_scrubbed"]
}
```

Create `tests/unit/sanitizer/fixtures/06-ellipsis.input.txt`:
```
Hmm… let me check
```

Create `tests/unit/sanitizer/fixtures/06-ellipsis.expected.json`:
```json
{
  "messages": ["Hmm let me check"],
  "modifications": ["forbidden_chars_scrubbed"]
}
```

- [ ] **Step 2: Write fixture-driven test**

Write `tests/unit/sanitizer/fixtures.spec.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sanitize } from '../../../src/sanitizer/index.js';

const fixturesDir = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures');
const inputs = readdirSync(fixturesDir).filter((f) => f.endsWith('.input.txt'));

const baseCtx = {
  bookingLink: 'https://example.com/book',
  bookingLinkSentInLastN: async () => false,
  policy: { maxWordsPerMessage: 40, maxEmojis: 2, bookingLinkDedupWindow: 3 },
};

describe('sanitizer fixture corpus', () => {
  for (const inputFile of inputs) {
    const name = inputFile.replace('.input.txt', '');
    it(name, async () => {
      const input = readFileSync(join(fixturesDir, inputFile), 'utf8').trim();
      const expectedFile = join(fixturesDir, `${name}.expected.json`);
      const expected = JSON.parse(readFileSync(expectedFile, 'utf8'));
      const result = await sanitize(input, baseCtx);
      expect(result.messages).toEqual(expected.messages);
      expect(result.modifications.sort()).toEqual(expected.modifications.sort());
    });
  }
});
```

- [ ] **Step 3: Run fixture tests**

Run: `npm run test:unit -- fixtures.spec.ts`
Expected: 6 PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/unit/sanitizer/fixtures/ tests/unit/sanitizer/fixtures.spec.ts
git commit -m "test: sanitizer fixture corpus with 6 representative cases"
```

---

### Task 14: Sanitizer — property-based invariants

**Files:**
- Create: `tests/unit/sanitizer/property.spec.ts`

- [ ] **Step 1: Write property-based test**

Write `tests/unit/sanitizer/property.spec.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { sanitize } from '../../../src/sanitizer/index.js';

const baseCtx = {
  bookingLink: 'https://example.com/book',
  bookingLinkSentInLastN: async () => false,
  policy: { maxWordsPerMessage: 40, maxEmojis: 2, bookingLinkDedupWindow: 3 },
};

const arbText = fc.string({ minLength: 1, maxLength: 800 });

describe('sanitizer invariants (property-based)', () => {
  it('messages length is always between 1 and 2 when not throwing', async () => {
    await fc.assert(
      fc.asyncProperty(arbText, async (text) => {
        try {
          const result = await sanitize(text, baseCtx);
          expect(result.messages.length).toBeGreaterThanOrEqual(1);
          expect(result.messages.length).toBeLessThanOrEqual(2);
        } catch (err) {
          expect((err as Error).name).toBe('SanitizerEmptyOutputError');
        }
      }),
      { numRuns: 2000 },
    );
  });

  it('each message has no forbidden chars and respects word/emoji caps', async () => {
    await fc.assert(
      fc.asyncProperty(arbText, async (text) => {
        try {
          const result = await sanitize(text, baseCtx);
          for (const m of result.messages) {
            expect(m).not.toMatch(/[—–…;]/);
            expect(m.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(40);
            const emojiCount = [...m.matchAll(/\p{Extended_Pictographic}/gu)].length;
            expect(emojiCount).toBeLessThanOrEqual(2);
            const linkCount = [...m.matchAll(/https?:\/\//g)].length;
            expect(linkCount).toBeLessThanOrEqual(1);
          }
        } catch (err) {
          expect((err as Error).name).toBe('SanitizerEmptyOutputError');
        }
      }),
      { numRuns: 2000 },
    );
  });
});
```

- [ ] **Step 2: Run property tests**

Run: `npm run test:unit -- property.spec.ts`
Expected: PASS (4000 iterations across 2 properties). Should complete within ~5-10s.

If a property fails, fast-check will print a minimal counterexample. Investigate the sanitizer logic, fix, re-run.

- [ ] **Step 3: Commit**

```bash
git add tests/unit/sanitizer/property.spec.ts
git commit -m "test: sanitizer property-based invariants (2k iterations each)"
```

---

## Phase 3 — Korak 3: Wire repos into handle-inbound (already done in Korak 1)

Repos were already wired in Task 8 and Task 9. No new tasks for Korak 3 — skip directly to Korak 4. The persistence is already real; only LLM and sanitizer were stubs.

---

## Phase 4 — Korak 4: Real LLM + prompt + tools + escalate

### Task 15: AnthropicLlmClient (replace stub)

**Files:**
- Modify: `src/llm/client.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Implement AnthropicLlmClient**

Append to `src/llm/client.ts`:
```typescript
import Anthropic from '@anthropic-ai/sdk';

export class AnthropicLlmClient implements LlmClient {
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey, timeout: 30_000, maxRetries: 2 });
  }

  async complete(input: LlmCompleteInput): Promise<LlmCompleteOutput> {
    const response = await this.client.messages.create({
      model: input.model,
      max_tokens: input.maxTokens,
      system: input.systemPrompt,
      messages: input.messages.map((m) => ({ role: m.role, content: m.content })),
      tools: input.tools.length > 0
        ? input.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema as Anthropic.Tool.InputSchema }))
        : undefined,
    });

    let text = '';
    const toolCalls: ToolCall[] = [];
    for (const block of response.content) {
      if (block.type === 'text') text += block.text;
      if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          name: block.name,
          arguments: (block.input as Record<string, unknown>) ?? {},
        });
      }
    }

    return {
      text,
      toolCalls,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    };
  }
}
```

- [ ] **Step 2: Swap stub for real client in composition root**

Modify `src/index.ts` — replace:
```typescript
import { StubLlmClient } from './llm/client.js';
```
With:
```typescript
import { AnthropicLlmClient } from './llm/client.js';
```

And replace:
```typescript
  const llm = new StubLlmClient();
```
With:
```typescript
  const llm = new AnthropicLlmClient(cfg.anthropicApiKey);
```

Update the `FastifyInstance.deps` type:
```typescript
    llm: AnthropicLlmClient;
```

- [ ] **Step 3: Verify compiles**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/llm/client.ts src/index.ts
git commit -m "feat: replace stub LlmClient with AnthropicLlmClient"
```

---

### Task 16: Prompt builder + tool definitions

**Files:**
- Create: `src/prompt/build.ts`
- Create: `src/prompt/tools.ts`

- [ ] **Step 1: Create tool definitions**

Write `src/prompt/tools.ts`:
```typescript
import type { ToolDefinition } from '../llm/client.js';

export const escalateToOwnerTool: ToolDefinition = {
  name: 'escalate_to_owner',
  description: 'Hand off the conversation to the salon owner. Use for complaints, refunds, VIP-named clients, or anything beyond bot scope.',
  input_schema: {
    type: 'object',
    properties: {
      reason: { type: 'string', description: 'Short reason e.g. "complaint", "refund_request", "vip_client".' },
      context_summary: { type: 'string', description: 'Optional one-sentence summary of what the client wants.' },
    },
    required: ['reason'],
  },
};

export const markLinkSentTool: ToolDefinition = {
  name: 'mark_link_sent',
  description: 'Call right before placing the booking link in the response. Records intent so the link is not repeated next turns.',
  input_schema: { type: 'object', properties: {} },
};

export const setStateFlagTool: ToolDefinition = {
  name: 'set_state_flag',
  description: 'Set a per-conversation state flag. Allowed keys: client_is_hesitant, last_quoted_service.',
  input_schema: {
    type: 'object',
    properties: {
      key: { type: 'string', enum: ['client_is_hesitant', 'last_quoted_service'] },
      value: {},
    },
    required: ['key', 'value'],
  },
};

export const allTools: ToolDefinition[] = [escalateToOwnerTool, markLinkSentTool, setStateFlagTool];
```

- [ ] **Step 2: Create prompt builder**

Write `src/prompt/build.ts`:
```typescript
import type { Salon, ConversationContext } from '../core/types.js';

export interface BuildPromptOutput {
  systemPrompt: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
}

export function buildPrompt(salon: Salon, ctx: ConversationContext, bookingLinkRecentlySent: boolean): BuildPromptOutput {
  const sot = salon.sourceOfTruth;
  const state = ctx.conversation.state;

  const systemPrompt = `You are answering Instagram DMs on behalf of ${sot.salon.name}, a hair salon. You are NOT an AI assistant — you respond as if you are the salon owner or front desk. Never reveal you are AI. Never mention 'I'm an AI'.

## Salon context
${JSON.stringify(sot, null, 2)}

## Conversation state
- Booking link sent in last ${salon.config.booking_link_dedup_window} messages: ${bookingLinkRecentlySent}
- Total inbound messages this conversation: ${ctx.recentMessages.filter((m) => m.direction === 'inbound').length}
- State flags: ${JSON.stringify(state)}

## Hard rules (non-negotiable)
- Maximum ${salon.config.max_words_per_message} words per message.
- Never use em-dashes, en-dashes, semicolons, ellipses.
- ${salon.config.max_emojis} emojis maximum, only when natural.
- One link maximum per message.
- Never quote firm prices for color/extensions — direct to consultation.
- For complaints, refunds, or VIP-named clients: call escalate_to_owner.

## Tools available
- escalate_to_owner(reason, context_summary?)
- mark_link_sent()
- set_state_flag(key, value)

## Voice
${sot.voice.tone_notes}
Signature phrases: ${sot.voice.signature_phrases.join(', ')}
Avoid: ${sot.voice.avoid.join(', ')}

Respond now as the salon owner. Output only the message text.`;

  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const m of ctx.recentMessages) {
    if (m.direction === 'inbound') {
      messages.push({ role: 'user', content: m.textContent ?? '' });
    } else if (m.direction === 'outbound' || m.direction === 'owner') {
      messages.push({ role: 'assistant', content: m.textContent ?? '' });
    }
  }

  return { systemPrompt, messages };
}
```

- [ ] **Step 3: Verify compiles**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/prompt/
git commit -m "feat: prompt builder with SoT injection and tool schema definitions"
```

---

### Task 17: Escalation handler + escalations repo

**Files:**
- Create: `src/db/repos/escalations.ts`
- Create: `src/core/escalate.ts`

- [ ] **Step 1: Create escalations repo**

Write `src/db/repos/escalations.ts`:
```typescript
import type { Db } from '../kysely.js';

export async function upsertActive(db: Db, conversationId: string, reason: string, contextSummary: string | null): Promise<void> {
  const existing = await db
    .selectFrom('escalations')
    .where('conversation_id', '=', conversationId)
    .where('resumed_at', 'is', null)
    .select('id')
    .executeTakeFirst();
  if (existing) {
    await db
      .updateTable('escalations')
      .set({ reason, context_summary: contextSummary, ghl_tag_added_at: new Date() })
      .where('id', '=', existing.id)
      .execute();
    return;
  }
  await db
    .insertInto('escalations')
    .values({
      conversation_id: conversationId,
      reason,
      context_summary: contextSummary,
      ghl_tag_added_at: new Date(),
    })
    .execute();
}

export interface ActiveTimedOutEscalation {
  escalationId: string;
  conversationId: string;
  contactId: string;
}

export async function listActiveTimedOut(db: Db, now: Date): Promise<ActiveTimedOutEscalation[]> {
  const rows = await db
    .selectFrom('escalations')
    .innerJoin('conversations', 'conversations.id', 'escalations.conversation_id')
    .where('escalations.resumed_at', 'is', null)
    .where('conversations.handoff_until', '<', now)
    .select([
      'escalations.id as escalationId',
      'conversations.id as conversationId',
      'conversations.ghl_contact_id as contactId',
    ])
    .execute();
  return rows;
}

export async function markResumed(db: Db, escalationId: string, resumedBy: 'auto_timeout' | 'owner_manual'): Promise<void> {
  await db
    .updateTable('escalations')
    .set({ resumed_at: new Date(), resumed_by: resumedBy })
    .where('id', '=', escalationId)
    .where('resumed_at', 'is', null)
    .execute();
}

export async function markResumedByConversation(db: Db, conversationId: string, resumedBy: 'auto_timeout' | 'owner_manual'): Promise<void> {
  await db
    .updateTable('escalations')
    .set({ resumed_at: new Date(), resumed_by: resumedBy })
    .where('conversation_id', '=', conversationId)
    .where('resumed_at', 'is', null)
    .execute();
}
```

- [ ] **Step 2: Create escalate handler**

Write `src/core/escalate.ts`:
```typescript
import type { Db } from '../db/kysely.js';
import type { GhlClient } from '../ghl/client.js';
import type { Salon, Conversation } from './types.js';
import * as escalationsRepo from '../db/repos/escalations.js';
import * as conversationsRepo from '../db/repos/conversations.js';
import * as eventsRepo from '../db/repos/events.js';
import { logger } from '../lib/logger.js';

export interface EscalateInput {
  db: Db;
  ghl: GhlClient;
  salon: Salon;
  conversation: Conversation;
  reason: string;
  contextSummary?: string;
}

export async function escalateToOwner(input: EscalateInput): Promise<void> {
  const handoffUntil = new Date(Date.now() + input.salon.config.handoff_window_hours * 3600_000);

  await input.db.transaction().execute(async (tx) => {
    await escalationsRepo.upsertActive(tx, input.conversation.id, input.reason, input.contextSummary ?? null);
    await conversationsRepo.setHandoffUntil(tx, input.conversation.id, handoffUntil);
    await eventsRepo.insert(tx, input.conversation.id, 'escalated_to_owner', { reason: input.reason });
  });

  try {
    await input.ghl.addTag(input.conversation.ghlContactId, ['escalation_active']);
    await input.ghl.updateCustomField({
      contactId: input.conversation.ghlContactId,
      fieldId: input.salon.config.ghl_custom_field_ids.last_escalation_reason,
      value: input.reason,
    });
  } catch (err) {
    logger.error({ err, conversationId: input.conversation.id }, 'ghl side-effect during escalate failed');
  }

  logger.info({ conversationId: input.conversation.id, reason: input.reason, handoffUntil }, 'escalated to owner');
}
```

- [ ] **Step 3: Verify compiles**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/db/repos/escalations.ts src/core/escalate.ts
git commit -m "feat: escalations repo and escalate-to-owner handler"
```

---

### Task 18: generate-response orchestrator (replace stub flow in handle-inbound)

**Files:**
- Create: `src/core/generate-response.ts`
- Modify: `src/core/handle-inbound.ts`

- [ ] **Step 1: Create generate-response orchestrator**

Write `src/core/generate-response.ts`:
```typescript
import type { Db } from '../db/kysely.js';
import type { GhlClient } from '../ghl/client.js';
import type { LlmClient } from '../llm/client.js';
import type { Salon } from './types.js';
import * as conversationsRepo from '../db/repos/conversations.js';
import * as messagesRepo from '../db/repos/messages.js';
import * as eventsRepo from '../db/repos/events.js';
import { sanitize } from '../sanitizer/index.js';
import { buildPrompt } from '../prompt/build.js';
import { allTools } from '../prompt/tools.js';
import { escalateToOwner } from './escalate.js';
import { SanitizerEmptyOutputError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

const ALLOWED_STATE_KEYS = ['client_is_hesitant', 'last_quoted_service'] as const;

export interface GenerateResponseDeps {
  db: Db;
  ghl: GhlClient;
  llm: LlmClient;
}

export async function generateResponse(deps: GenerateResponseDeps, salon: Salon, conversationId: string): Promise<void> {
  const ctx = await conversationsRepo.loadContext(deps.db, conversationId, 15);

  if (ctx.conversation.handoffUntil && ctx.conversation.handoffUntil > new Date()) {
    logger.info({ conversationId }, 'handoff active at worker; skipping');
    return;
  }

  const bookingLinkRecentlySent = await eventsRepo.recentBookingLinkSent(
    deps.db,
    conversationId,
    salon.config.booking_link_dedup_window,
  );
  const prompt = buildPrompt(salon, ctx, bookingLinkRecentlySent);

  let llmResult: Awaited<ReturnType<typeof deps.llm.complete>>;
  let attempts = 0;
  while (true) {
    try {
      llmResult = await deps.llm.complete({
        systemPrompt: prompt.systemPrompt,
        messages: prompt.messages,
        tools: allTools,
        model: salon.config.llm_model,
        maxTokens: 512,
      });
      break;
    } catch (err) {
      attempts++;
      if (attempts >= 3) {
        await escalateToOwner({
          db: deps.db,
          ghl: deps.ghl,
          salon,
          conversation: ctx.conversation,
          reason: 'llm_failed',
        });
        return;
      }
      const backoff = 500 * 2 ** attempts;
      await new Promise((r) => setTimeout(r, backoff));
    }
  }

  let escalated = false;
  let linkSentToolCalled = false;
  for (const call of llmResult.toolCalls) {
    if (call.name === 'escalate_to_owner') {
      const reason = (call.arguments.reason as string | undefined) ?? 'unspecified';
      const summary = call.arguments.context_summary as string | undefined;
      await escalateToOwner({
        db: deps.db,
        ghl: deps.ghl,
        salon,
        conversation: ctx.conversation,
        reason,
        contextSummary: summary,
      });
      escalated = true;
      break;
    } else if (call.name === 'mark_link_sent') {
      await eventsRepo.insert(deps.db, conversationId, 'booking_link_sent', {});
      linkSentToolCalled = true;
    } else if (call.name === 'set_state_flag') {
      const key = call.arguments.key as string | undefined;
      const value = call.arguments.value;
      if (key && (ALLOWED_STATE_KEYS as readonly string[]).includes(key)) {
        await conversationsRepo.mergeState(deps.db, conversationId, { [key]: value });
      } else {
        logger.warn({ conversationId, key }, 'rejected unknown state flag');
      }
    }
  }
  if (escalated) return;

  let sanitized: Awaited<ReturnType<typeof sanitize>>;
  try {
    sanitized = await sanitize(llmResult.text, {
      bookingLink: salon.sourceOfTruth.salon.booking_link,
      bookingLinkSentInLastN: (n) => eventsRepo.recentBookingLinkSent(deps.db, conversationId, n),
      policy: {
        maxWordsPerMessage: salon.config.max_words_per_message,
        maxEmojis: salon.config.max_emojis,
        bookingLinkDedupWindow: salon.config.booking_link_dedup_window,
      },
    });
  } catch (err) {
    if (err instanceof SanitizerEmptyOutputError) {
      await escalateToOwner({
        db: deps.db,
        ghl: deps.ghl,
        salon,
        conversation: ctx.conversation,
        reason: 'sanitizer_empty_output',
      });
      return;
    }
    throw err;
  }

  for (const message of sanitized.messages) {
    try {
      const sent = await deps.ghl.sendMessage({
        contactId: ctx.conversation.ghlContactId,
        type: 'IG',
        message,
      });
      await messagesRepo.insertOutbound(deps.db, {
        conversationId,
        textContent: message,
        aiRawOutput: llmResult.text,
        sanitizeMods: sanitized.modifications,
        promptTokens: llmResult.usage.inputTokens,
        completionTokens: llmResult.usage.outputTokens,
        costUsd: null,
        ghlMessageId: sent.ghlMessageId,
      });
    } catch (err) {
      await escalateToOwner({
        db: deps.db,
        ghl: deps.ghl,
        salon,
        conversation: ctx.conversation,
        reason: 'cannot_reply_outside_window',
      });
      return;
    }
  }

  // Defense in depth: ensure booking_link_sent event exists if link is in output.
  if (!linkSentToolCalled) {
    const containsLink = sanitized.messages.some((m) => m.includes(salon.sourceOfTruth.salon.booking_link));
    if (containsLink) {
      await eventsRepo.insert(deps.db, conversationId, 'booking_link_sent', {});
    }
  }
}
```

- [ ] **Step 2: Update handle-inbound to delegate to generate-response**

Replace `src/core/handle-inbound.ts` content:
```typescript
import type { Db } from '../db/kysely.js';
import type { GhlClient } from '../ghl/client.js';
import type { LlmClient } from '../llm/client.js';
import * as salonsRepo from '../db/repos/salons.js';
import * as conversationsRepo from '../db/repos/conversations.js';
import * as messagesRepo from '../db/repos/messages.js';
import { generateResponse } from './generate-response.js';
import { logger } from '../lib/logger.js';

export interface HandleInboundInput {
  locationId: string;
  contactId: string;
  contactHandle: string | null;
  messageId: string | null;
  messageText: string | null;
  rawPayload: unknown;
}

export interface HandleInboundDeps {
  db: Db;
  ghl: GhlClient;
  llm: LlmClient;
}

export async function handleInbound(deps: HandleInboundDeps, input: HandleInboundInput): Promise<void> {
  const salon = await salonsRepo.findByLocationId(deps.db, input.locationId);
  if (!salon) {
    logger.info({ locationId: input.locationId }, 'salon not found for inbound; dropping');
    return;
  }

  let textContent = input.messageText ?? '';
  if (!textContent && input.messageId) {
    const fetched = await deps.ghl.getMessage(input.messageId);
    textContent = fetched.text;
  }
  if (!textContent) {
    logger.warn({ locationId: input.locationId, contactId: input.contactId }, 'inbound has no text; dropping');
    return;
  }

  const conversation = await conversationsRepo.findOrCreate(deps.db, salon.id, input.contactId, input.contactHandle);

  const inserted = await messagesRepo.insertInbound(deps.db, {
    conversationId: conversation.id,
    channelType: 'text',
    rawContent: input.rawPayload,
    textContent,
    ghlMessageId: input.messageId,
  });
  if (!inserted) {
    logger.debug({ messageId: input.messageId }, 'idempotent duplicate; skipping');
    return;
  }

  await conversationsRepo.touchLastMessageAt(deps.db, conversation.id, new Date());

  if (conversation.handoffUntil && conversation.handoffUntil > new Date()) {
    logger.info({ conversationId: conversation.id }, 'handoff active; bot paused');
    return;
  }

  // Korak 4: synchronous direct call. Replaced with BullMQ scheduling in Korak 5.
  await generateResponse(deps, salon, conversation.id);
}
```

- [ ] **Step 3: Manual smoke against real Anthropic**

Make sure `.env` has a valid `ANTHROPIC_API_KEY`.

Start server: `npm run dev`

Send inbound (assuming salon exists from Task 9):
```bash
curl -X POST http://localhost:3000/dev/simulate-inbound \
  -H "Content-Type: application/json" \
  -d '{"location_id":"loc_bella","contact_id":"contact_test_2","message_text":"Hi do you do balayage and how much?"}'
```
Expected: `{"accepted":true,...}` and after a few seconds, log shows real Claude response, sanitized output, and mock_outbound_log gets a new row.

Verify:
```bash
docker exec -it $(docker compose ps -q postgres) psql -U salon -d salon -c "SELECT direction, text_content, ai_raw_output FROM messages ORDER BY created_at DESC LIMIT 5"
```

Stop server.

- [ ] **Step 4: Commit**

```bash
git add src/core/generate-response.ts src/core/handle-inbound.ts
git commit -m "feat: generate-response orchestrator with prompt + tools + sanitize + send (Korak 4 complete)"
```

---

## Phase 5 — Korak 5: BullMQ + delay + coalescing

### Task 19: BullMQ queue setup + worker module

**Files:**
- Create: `src/queue/index.ts`
- Create: `src/workers/respond.ts`
- Modify: `src/index.ts`
- Modify: `src/core/handle-inbound.ts`

- [ ] **Step 1: Create queue module**

Write `src/queue/index.ts`:
```typescript
import { Queue, type ConnectionOptions } from 'bullmq';
import { Redis } from 'ioredis';

export interface RespondJobData {
  conversationId: string;
  salonId: string;
}

export function createConnection(redisUrl: string): Redis {
  return new Redis(redisUrl, { maxRetriesPerRequest: null });
}

export function createRespondQueue(connection: ConnectionOptions): Queue<RespondJobData> {
  return new Queue<RespondJobData>('respond', { connection });
}
```

- [ ] **Step 2: Create worker for respond jobs**

Write `src/workers/respond.ts`:
```typescript
import { Worker, type ConnectionOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Db } from '../db/kysely.js';
import type { GhlClient } from '../ghl/client.js';
import type { LlmClient } from '../llm/client.js';
import * as salonsRepo from '../db/repos/salons.js';
import { generateResponse } from '../core/generate-response.js';
import type { RespondJobData } from '../queue/index.js';
import { logger } from '../lib/logger.js';

export interface BuildRespondWorkerDeps {
  db: Db;
  redis: Redis;
  ghl: GhlClient;
  llm: LlmClient;
  connection: ConnectionOptions;
}

export function buildRespondWorker(deps: BuildRespondWorkerDeps): Worker<RespondJobData> {
  return new Worker<RespondJobData>(
    'respond',
    async (job) => {
      const lockKey = `conversation:${job.data.conversationId}:lock`;
      const acquired = await deps.redis.set(lockKey, job.id ?? 'job', 'EX', 60, 'NX');
      if (acquired !== 'OK') {
        logger.info({ conversationId: job.data.conversationId }, 'lock not acquired; another worker is handling');
        return;
      }
      try {
        const salon = await salonsRepo.findById(deps.db, job.data.salonId);
        if (!salon) {
          logger.warn({ salonId: job.data.salonId }, 'salon disappeared between schedule and run; dropping');
          return;
        }
        await generateResponse({ db: deps.db, ghl: deps.ghl, llm: deps.llm }, salon, job.data.conversationId);
      } finally {
        await deps.redis.del(lockKey);
      }
    },
    { connection: deps.connection, concurrency: 4 },
  );
}
```

- [ ] **Step 3: Wire queue + worker into composition root**

Modify `src/index.ts`:

Replace existing imports section and main with:
```typescript
import Fastify from 'fastify';
import { loadConfig } from './config.js';
import { createKyselyDb } from './db/kysely.js';
import { MockGhlClient } from './ghl/mock.js';
import { AnthropicLlmClient } from './llm/client.js';
import { logger } from './lib/logger.js';
import { inboundWebhookRoute } from './routes/webhooks-ghl-inbound.js';
import { devSimulateRoute } from './routes/dev-simulate.js';
import { adminSalonsRoute } from './routes/admin-salons.js';
import { createConnection, createRespondQueue, type RespondJobData } from './queue/index.js';
import { buildRespondWorker } from './workers/respond.js';
import type { Queue } from 'bullmq';

async function main() {
  const cfg = loadConfig();
  const db = createKyselyDb(cfg.databaseUrl);
  const redis = createConnection(cfg.redisUrl);
  const llm = new AnthropicLlmClient(cfg.anthropicApiKey);
  const ghl = new MockGhlClient(db);
  const respondQueue = createRespondQueue({ host: redisUrlHost(cfg.redisUrl), port: redisUrlPort(cfg.redisUrl) });
  const worker = buildRespondWorker({
    db,
    redis,
    ghl,
    llm,
    connection: { host: redisUrlHost(cfg.redisUrl), port: redisUrlPort(cfg.redisUrl) },
  });

  const app = Fastify({ logger: false });

  app.get('/health', async () => ({ status: 'ok', ts: new Date().toISOString() }));

  const deps = { db, redis, ghl, llm, cfg, respondQueue } as const;
  app.decorate('deps', deps);

  await app.register(inboundWebhookRoute);
  await app.register(devSimulateRoute);
  await app.register(adminSalonsRoute);

  app.setErrorHandler((err, _req, reply) => {
    logger.error({ err }, 'unhandled error');
    reply.code(500).send({ error: 'internal_error' });
  });

  await app.listen({ port: cfg.port, host: '0.0.0.0' });
  logger.info({ port: cfg.port }, 'server listening; worker active');

  const shutdown = async () => {
    logger.info('shutting down');
    await app.close();
    await worker.close();
    await respondQueue.close();
    await redis.quit();
    await db.destroy();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

function redisUrlHost(url: string): string {
  return new URL(url).hostname;
}

function redisUrlPort(url: string): number {
  return Number(new URL(url).port || 6379);
}

main().catch((err) => {
  logger.error({ err }, 'fatal startup error');
  process.exit(1);
});

declare module 'fastify' {
  interface FastifyInstance {
    deps: {
      db: ReturnType<typeof createKyselyDb>;
      redis: ReturnType<typeof createConnection>;
      ghl: MockGhlClient;
      llm: AnthropicLlmClient;
      cfg: ReturnType<typeof loadConfig>;
      respondQueue: Queue<RespondJobData>;
    };
  }
}
```

- [ ] **Step 4: Modify handle-inbound to schedule via queue with coalescing**

Replace the synchronous `await generateResponse(...)` line in `src/core/handle-inbound.ts`. First, update the function signature to accept the queue.

Replace the entire `HandleInboundDeps` interface:
```typescript
import type { Queue } from 'bullmq';
import type { RespondJobData } from '../queue/index.js';

export interface HandleInboundDeps {
  db: Db;
  ghl: GhlClient;
  llm: LlmClient;
  respondQueue: Queue<RespondJobData>;
  responseDelayMsOverride?: number;
}
```

And replace the last block:
```typescript
  // Korak 4: synchronous direct call. Replaced with BullMQ scheduling in Korak 5.
  await generateResponse(deps, salon, conversation.id);
}
```

With:
```typescript
  const jobId = `respond:${conversation.id}`;
  const delay = deps.responseDelayMsOverride ?? salon.config.response_delay_ms;

  await deps.respondQueue.remove(jobId).catch(() => undefined);
  await deps.respondQueue.add(
    'respond',
    { conversationId: conversation.id, salonId: salon.id },
    { jobId, delay, removeOnComplete: true, removeOnFail: 10 },
  );
}
```

Remove the now-unused import of `generateResponse` from handle-inbound.

- [ ] **Step 5: Update route handlers to pass respondQueue**

Modify `src/routes/webhooks-ghl-inbound.ts` and `src/routes/dev-simulate.ts` — in each `handleInbound(...)` call, change deps from `{ db: app.deps.db, ghl: app.deps.ghl, llm: app.deps.llm }` to `{ db: app.deps.db, ghl: app.deps.ghl, llm: app.deps.llm, respondQueue: app.deps.respondQueue }`.

- [ ] **Step 6: Manual smoke test of coalescing**

Start server: `npm run dev`

Send 3 inbounds within 5 seconds:
```bash
for i in 1 2 3; do
  curl -X POST http://localhost:3000/dev/simulate-inbound \
    -H "Content-Type: application/json" \
    -d "{\"location_id\":\"loc_bella\",\"contact_id\":\"contact_burst\",\"message_text\":\"part $i\"}"
  sleep 1
done
```

Wait ~45 seconds (default response delay). Check that only ONE outbound message was sent for `contact_burst`:
```bash
docker exec -it $(docker compose ps -q postgres) psql -U salon -d salon -c \
  "SELECT count(*) FROM mock_outbound_log WHERE contact_id='contact_burst'"
```
Expected: count = 1.

Check messages — 3 inbounds, 1 outbound:
```bash
docker exec -it $(docker compose ps -q postgres) psql -U salon -d salon -c \
  "SELECT direction, text_content FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.ghl_contact_id='contact_burst' ORDER BY m.created_at"
```
Expected: 3 inbounds + 1 outbound.

Stop server.

- [ ] **Step 7: Commit**

```bash
git add src/queue/ src/workers/respond.ts src/core/handle-inbound.ts src/index.ts src/routes/
git commit -m "feat: BullMQ async worker with rolling-delay coalescing and Redis lock"
```

---

## Phase 6 — Korak 6: Escalation flow (resume webhook + auto-resume)

### Task 20: Resume webhook endpoint

**Files:**
- Create: `src/routes/webhooks-ghl-resume.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Create resume webhook route**

Write `src/routes/webhooks-ghl-resume.ts`:
```typescript
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as salonsRepo from '../db/repos/salons.js';
import * as conversationsRepo from '../db/repos/conversations.js';
import * as escalationsRepo from '../db/repos/escalations.js';
import * as eventsRepo from '../db/repos/events.js';
import { logger } from '../lib/logger.js';

const ResumePayloadSchema = z.object({
  location_id: z.string(),
  contact_id: z.string(),
});

export async function resumeWebhookRoute(app: FastifyInstance): Promise<void> {
  app.post('/webhooks/ghl/resume', async (request, reply) => {
    const secret = request.headers['x-webhook-secret'];
    if (secret !== app.deps.cfg.webhookSecret) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const parsed = ResumePayloadSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_payload' });
    }
    reply.code(200).send({ accepted: true });

    setImmediate(async () => {
      try {
        const salon = await salonsRepo.findByLocationId(app.deps.db, parsed.data.location_id);
        if (!salon) {
          logger.warn({ locationId: parsed.data.location_id }, 'resume: salon not found');
          return;
        }
        const conv = await app.deps.db
          .selectFrom('conversations')
          .where('salon_id', '=', salon.id)
          .where('ghl_contact_id', '=', parsed.data.contact_id)
          .select(['id'])
          .executeTakeFirst();
        if (!conv) {
          logger.warn({ contactId: parsed.data.contact_id }, 'resume: conversation not found');
          return;
        }
        await conversationsRepo.setHandoffUntil(app.deps.db, conv.id, null);
        await escalationsRepo.markResumedByConversation(app.deps.db, conv.id, 'owner_manual');
        await eventsRepo.insert(app.deps.db, conv.id, 'bot_resumed', { by: 'owner_manual' });
        logger.info({ conversationId: conv.id }, 'manual resume completed');
      } catch (err) {
        logger.error({ err }, 'resume webhook handler failed');
      }
    });
  });
}
```

- [ ] **Step 2: Register resume route**

Modify `src/index.ts` — after `await app.register(adminSalonsRoute);` add:
```typescript
  await app.register(resumeWebhookRoute);
```

And import:
```typescript
import { resumeWebhookRoute } from './routes/webhooks-ghl-resume.js';
```

- [ ] **Step 3: Verify compiles**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/routes/webhooks-ghl-resume.ts src/index.ts
git commit -m "feat: resume webhook endpoint for manual escalation resume"
```

---

### Task 21: Auto-resume recurring worker

**Files:**
- Create: `src/workers/auto-resume.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Create auto-resume worker**

Write `src/workers/auto-resume.ts`:
```typescript
import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import type { Db } from '../db/kysely.js';
import type { GhlClient } from '../ghl/client.js';
import * as escalationsRepo from '../db/repos/escalations.js';
import * as conversationsRepo from '../db/repos/conversations.js';
import * as eventsRepo from '../db/repos/events.js';
import { logger } from '../lib/logger.js';

const AUTO_RESUME_QUEUE = 'auto-resume';
const AUTO_RESUME_INTERVAL_MS = 5 * 60 * 1000;

export async function setupAutoResume(deps: {
  db: Db;
  ghl: GhlClient;
  connection: ConnectionOptions;
}): Promise<{ queue: Queue; worker: Worker }> {
  const queue = new Queue(AUTO_RESUME_QUEUE, { connection: deps.connection });

  // Idempotent: BullMQ deduplicates repeat jobs by name + repeat options.
  await queue.add(
    'auto-resume-tick',
    {},
    {
      repeat: { every: AUTO_RESUME_INTERVAL_MS },
      removeOnComplete: true,
      removeOnFail: 10,
    },
  );

  const worker = new Worker(
    AUTO_RESUME_QUEUE,
    async () => {
      const now = new Date();
      const items = await escalationsRepo.listActiveTimedOut(deps.db, now);
      for (const item of items) {
        try {
          await escalationsRepo.markResumed(deps.db, item.escalationId, 'auto_timeout');
          await conversationsRepo.setHandoffUntil(deps.db, item.conversationId, null);
          await deps.ghl.removeTag(item.contactId, ['escalation_active']);
          await eventsRepo.insert(deps.db, item.conversationId, 'bot_resumed', { by: 'auto_timeout' });
          logger.info({ escalationId: item.escalationId }, 'auto-resumed');
        } catch (err) {
          logger.error({ err, escalationId: item.escalationId }, 'auto-resume failed for escalation');
        }
      }
    },
    { connection: deps.connection, concurrency: 1 },
  );

  return { queue, worker };
}
```

- [ ] **Step 2: Wire into composition root**

Modify `src/index.ts`:

After:
```typescript
  const worker = buildRespondWorker({ ... });
```

Add:
```typescript
  const autoResume = await setupAutoResume({
    db,
    ghl,
    connection: { host: redisUrlHost(cfg.redisUrl), port: redisUrlPort(cfg.redisUrl) },
  });
```

In shutdown, add before `await respondQueue.close();`:
```typescript
    await autoResume.worker.close();
    await autoResume.queue.close();
```

Add import:
```typescript
import { setupAutoResume } from './workers/auto-resume.js';
```

- [ ] **Step 3: Manual smoke (full escalation lifecycle)**

Start server: `npm run dev`

Trigger escalation manually with SQL (faster than waiting for LLM to call the tool):
```bash
docker exec -it $(docker compose ps -q postgres) psql -U salon -d salon <<'SQL'
WITH conv AS (
  SELECT c.id AS conv_id, s.id AS salon_id
  FROM conversations c JOIN salons s ON s.id = c.salon_id
  WHERE c.ghl_contact_id = 'contact_test_2'
  LIMIT 1
)
UPDATE conversations SET handoff_until = now() - interval '1 minute' WHERE id IN (SELECT conv_id FROM conv);
INSERT INTO escalations (conversation_id, reason, ghl_tag_added_at)
  SELECT conv_id, 'manual_test', now() - interval '5 minute' FROM conv;
INSERT INTO mock_contact_state (contact_id, tags) VALUES ('contact_test_2', '["escalation_active"]'::jsonb)
  ON CONFLICT (contact_id) DO UPDATE SET tags = '["escalation_active"]'::jsonb;
SQL
```

Wait up to 5 minutes for auto-resume to fire. Then verify:
```bash
docker exec -it $(docker compose ps -q postgres) psql -U salon -d salon -c \
  "SELECT resumed_at, resumed_by FROM escalations ORDER BY created_at DESC LIMIT 1; \
   SELECT handoff_until FROM conversations WHERE ghl_contact_id='contact_test_2'; \
   SELECT tags FROM mock_contact_state WHERE contact_id='contact_test_2'"
```
Expected: escalation has `resumed_at` set and `resumed_by='auto_timeout'`; conversation has `handoff_until=null`; mock_contact_state.tags is `[]` (or no longer contains escalation_active).

Test manual resume too:
```bash
curl -X POST http://localhost:3000/webhooks/ghl/resume \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: dev-secret-change-me" \
  -d '{"location_id":"loc_bella","contact_id":"contact_test_2"}'
```
Expected: `{"accepted":true}` and bot_resumed event recorded.

Stop server.

- [ ] **Step 4: Commit**

```bash
git add src/workers/auto-resume.ts src/index.ts
git commit -m "feat: auto-resume recurring worker (5min) and full escalation lifecycle wired (Korak 6 complete)"
```

---

## Phase 7 — Korak 7: Golden e2e tests + CI

### Task 22: Test infrastructure + FakeLlmClient + fixture

**Files:**
- Create: `tests/helpers/test-db.ts`
- Create: `tests/helpers/fake-llm-client.ts`
- Create: `tests/e2e/fixtures/salon-bella.json`
- Create: `tests/helpers/test-app.ts`
- Create: `docker-compose.test.yml`

- [ ] **Step 1: Create test docker-compose with separate ports**

Write `docker-compose.test.yml`:
```yaml
services:
  postgres-test:
    image: postgres:15-alpine
    environment:
      POSTGRES_USER: salon
      POSTGRES_PASSWORD: salon
      POSTGRES_DB: salon_test
    ports:
      - "55432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U salon"]
      interval: 5s
      timeout: 5s
      retries: 5

  redis-test:
    image: redis:7-alpine
    ports:
      - "56379:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 5s
      retries: 5
```

- [ ] **Step 2: Start test infrastructure**

Run:
```bash
docker compose -f docker-compose.test.yml up -d
```

- [ ] **Step 3: Create test-db helper**

Write `tests/helpers/test-db.ts`:
```typescript
import { Kysely, Migrator, PostgresDialect, FileMigrationProvider, sql } from 'kysely';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { Database } from '../../src/db/schema.js';

const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://salon:salon@localhost:55432/salon_test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createTestDb(): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString: TEST_DB_URL }),
    }),
  });
}

export async function migrateTestDb(): Promise<void> {
  const db = createTestDb();
  const migrator = new Migrator({
    db: db as unknown as Kysely<unknown>,
    provider: new FileMigrationProvider({
      fs,
      path,
      migrationFolder: path.resolve(__dirname, '../../src/db/migrations'),
    }),
  });
  await migrator.migrateToLatest();
  await db.destroy();
}

export async function truncateAll(db: Kysely<Database>): Promise<void> {
  await sql`
    TRUNCATE TABLE
      mock_contact_state,
      mock_outbound_log,
      escalations,
      conversation_events,
      messages,
      conversations,
      salons
    RESTART IDENTITY CASCADE
  `.execute(db);
}
```

- [ ] **Step 4: Create FakeLlmClient**

Write `tests/helpers/fake-llm-client.ts`:
```typescript
import type { LlmClient, LlmCompleteInput, LlmCompleteOutput, ToolCall } from '../../src/llm/client.js';

export interface StagedResponse {
  match: (input: LlmCompleteInput) => boolean;
  output: { text: string; toolCalls?: ToolCall[] };
}

export class FakeLlmClient implements LlmClient {
  private staged: StagedResponse[] = [];
  public calls: LlmCompleteInput[] = [];

  stage(response: StagedResponse): void {
    this.staged.push(response);
  }

  reset(): void {
    this.staged = [];
    this.calls = [];
  }

  async complete(input: LlmCompleteInput): Promise<LlmCompleteOutput> {
    this.calls.push(input);
    const matched = this.staged.find((s) => s.match(input));
    if (!matched) {
      throw new Error(`FakeLlmClient: no staged response matched. Last user message: ${JSON.stringify(input.messages.at(-1))}`);
    }
    return {
      text: matched.output.text,
      toolCalls: matched.output.toolCalls ?? [],
      usage: { inputTokens: 100, outputTokens: 50 },
    };
  }
}
```

- [ ] **Step 5: Create test-app helper for spinning up Fastify per test**

Write `tests/helpers/test-app.ts`:
```typescript
import Fastify from 'fastify';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import type { Kysely } from 'kysely';
import type { Database } from '../../src/db/schema.js';
import { MockGhlClient } from '../../src/ghl/mock.js';
import { inboundWebhookRoute } from '../../src/routes/webhooks-ghl-inbound.js';
import { devSimulateRoute } from '../../src/routes/dev-simulate.js';
import { adminSalonsRoute } from '../../src/routes/admin-salons.js';
import { resumeWebhookRoute } from '../../src/routes/webhooks-ghl-resume.js';
import { buildRespondWorker } from '../../src/workers/respond.js';
import type { RespondJobData } from '../../src/queue/index.js';
import type { LlmClient } from '../../src/llm/client.js';
import type { FastifyInstance } from 'fastify';

const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:56379';

export interface TestApp {
  app: FastifyInstance;
  queue: Queue<RespondJobData>;
  worker: Worker<RespondJobData>;
  ghl: MockGhlClient;
  redis: Redis;
  shutdown: () => Promise<void>;
}

export async function buildTestApp(db: Kysely<Database>, llm: LlmClient): Promise<TestApp> {
  const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
  const connection = { host: new URL(REDIS_URL).hostname, port: Number(new URL(REDIS_URL).port || 6379) };
  const queue = new Queue<RespondJobData>('respond', { connection });
  const ghl = new MockGhlClient(db);
  const worker = buildRespondWorker({ db, redis, ghl, llm, connection });

  const cfg = {
    port: 0,
    nodeEnv: 'test' as const,
    logLevel: 'silent' as const,
    databaseUrl: '',
    redisUrl: REDIS_URL,
    webhookSecret: 'test-secret',
    adminApiKey: 'test-admin',
    anthropicApiKey: 'unused',
    llmModel: 'claude-sonnet-4-5',
  };

  const app = Fastify({ logger: false });
  app.decorate('deps', { db, redis, ghl, llm, cfg, respondQueue: queue });

  await app.register(inboundWebhookRoute);
  await app.register(devSimulateRoute);
  await app.register(adminSalonsRoute);
  await app.register(resumeWebhookRoute);

  return {
    app,
    queue,
    worker,
    ghl,
    redis,
    shutdown: async () => {
      await app.close();
      await worker.close();
      await queue.close();
      await redis.quit();
      await new Promise((r) => setTimeout(r, 100));
    },
  };
}
```

- [ ] **Step 6: Create salon-bella fixture**

Write `tests/e2e/fixtures/salon-bella.json`:
```json
{
  "display_name": "Bella Hair Studio",
  "ghl_location_id": "loc_bella_test",
  "ghl_pit": "test-pit",
  "source_of_truth": {
    "salon": {
      "name": "Bella Hair Studio",
      "owner_first_name": "Sarah",
      "location": "Toronto, ON",
      "timezone": "America/Toronto",
      "hours": {"mon":"closed","tue":"10:00-19:00"},
      "booking_link": "https://bellahair.example.com/book"
    },
    "stylists": [{"name":"Sarah","specialties":["balayage"]}],
    "services": [{"name":"Balayage","price_range":{"min":250,"max":400,"currency":"CAD"},"requires_consultation":true}],
    "voice": {"tone_notes":"Warm, casual"}
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

Note: `response_delay_ms: 100` so e2e tests don't wait 40s.

- [ ] **Step 7: Bootstrap test DB**

Run:
```bash
TEST_DATABASE_URL=postgres://salon:salon@localhost:55432/salon_test \
  npx tsx -e "import('./tests/helpers/test-db.js').then(m => m.migrateTestDb()).then(() => process.exit(0))"
```
Expected: migrations apply to the test DB.

- [ ] **Step 8: Commit**

```bash
git add tests/helpers/ tests/e2e/fixtures/ docker-compose.test.yml
git commit -m "test: e2e infrastructure with test-db helper, FakeLlmClient, and fixture"
```

---

### Task 23: Golden e2e #1 — Simple Q&A

**Files:**
- Create: `tests/e2e/01-simple-qa.spec.ts`

- [ ] **Step 1: Write the test**

Write `tests/e2e/01-simple-qa.spec.ts`:
```typescript
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDb, migrateTestDb, truncateAll } from '../helpers/test-db.js';
import { FakeLlmClient } from '../helpers/fake-llm-client.js';
import { buildTestApp } from '../helpers/test-app.js';
import * as salonsRepo from '../../src/db/repos/salons.js';

const fixturesDir = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures');

describe('e2e #1 — simple Q&A', () => {
  const db = createTestDb();
  let testApp: Awaited<ReturnType<typeof buildTestApp>>;
  let llm: FakeLlmClient;

  beforeAll(async () => {
    await migrateTestDb();
  });

  beforeEach(async () => {
    await truncateAll(db);
    llm = new FakeLlmClient();
    testApp = await buildTestApp(db, llm);
  });

  afterAll(async () => {
    await testApp.shutdown();
    await db.destroy();
  });

  it('responds with sanitized text and persists outbound', async () => {
    const fixture = JSON.parse(readFileSync(join(fixturesDir, 'salon-bella.json'), 'utf8'));
    const salon = await salonsRepo.create(db, {
      displayName: fixture.display_name,
      ghlLocationId: fixture.ghl_location_id,
      ghlPit: fixture.ghl_pit,
      sourceOfTruth: fixture.source_of_truth,
      config: fixture.config,
    });

    llm.stage({
      match: () => true,
      output: { text: 'Hi! Yes we do balayage. Want to come in this week?' },
    });

    const res = await testApp.app.inject({
      method: 'POST',
      url: '/dev/simulate-inbound',
      payload: {
        location_id: salon.ghlLocationId,
        contact_id: 'c_qa',
        message_text: 'do you do balayage?',
      },
    });
    expect(res.statusCode).toBe(202);

    // Wait for queue + worker
    await new Promise((r) => setTimeout(r, 1500));

    const outbound = await db
      .selectFrom('messages')
      .where('direction', '=', 'outbound')
      .selectAll()
      .execute();
    expect(outbound).toHaveLength(1);
    expect(outbound[0].text_content).toContain('balayage');

    const log = await db.selectFrom('mock_outbound_log').selectAll().execute();
    expect(log).toHaveLength(1);
    expect(log[0].message).toContain('balayage');
  });
});
```

- [ ] **Step 2: Run the test**

Run: `TEST_DATABASE_URL=postgres://salon:salon@localhost:55432/salon_test TEST_REDIS_URL=redis://localhost:56379 npm run test:e2e -- 01-simple-qa.spec.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/01-simple-qa.spec.ts
git commit -m "test: golden e2e #1 simple Q&A passes"
```

---

### Task 24: Golden e2e #2 — Booking link dedup across turns

**Files:**
- Create: `tests/e2e/02-booking-link-dedup.spec.ts`

- [ ] **Step 1: Write the test**

Write `tests/e2e/02-booking-link-dedup.spec.ts`:
```typescript
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDb, migrateTestDb, truncateAll } from '../helpers/test-db.js';
import { FakeLlmClient } from '../helpers/fake-llm-client.js';
import { buildTestApp } from '../helpers/test-app.js';
import * as salonsRepo from '../../src/db/repos/salons.js';

const fixturesDir = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures');

describe('e2e #2 — booking link dedup across turns', () => {
  const db = createTestDb();
  let testApp: Awaited<ReturnType<typeof buildTestApp>>;
  let llm: FakeLlmClient;

  beforeAll(async () => {
    await migrateTestDb();
  });

  beforeEach(async () => {
    await truncateAll(db);
    llm = new FakeLlmClient();
    testApp = await buildTestApp(db, llm);
  });

  afterAll(async () => {
    await testApp.shutdown();
    await db.destroy();
  });

  it('first turn keeps link, second turn strips it', async () => {
    const fixture = JSON.parse(readFileSync(join(fixturesDir, 'salon-bella.json'), 'utf8'));
    const salon = await salonsRepo.create(db, {
      displayName: fixture.display_name,
      ghlLocationId: fixture.ghl_location_id,
      ghlPit: fixture.ghl_pit,
      sourceOfTruth: fixture.source_of_truth,
      config: fixture.config,
    });

    const linkResponse = 'Sure! Book here https://bellahair.example.com/book';
    llm.stage({ match: () => true, output: { text: linkResponse } });

    await testApp.app.inject({
      method: 'POST',
      url: '/dev/simulate-inbound',
      payload: { location_id: salon.ghlLocationId, contact_id: 'c_dedup', message_text: 'send me the link' },
    });
    await new Promise((r) => setTimeout(r, 1500));

    const outboundsTurn1 = await db
      .selectFrom('messages')
      .where('direction', '=', 'outbound')
      .selectAll()
      .execute();
    expect(outboundsTurn1).toHaveLength(1);
    expect(outboundsTurn1[0].text_content).toContain('https://bellahair.example.com/book');

    // Same response staged for turn 2; sanitizer should strip the link.
    await testApp.app.inject({
      method: 'POST',
      url: '/dev/simulate-inbound',
      payload: { location_id: salon.ghlLocationId, contact_id: 'c_dedup', message_text: 'one more time?' },
    });
    await new Promise((r) => setTimeout(r, 1500));

    const outboundsAll = await db
      .selectFrom('messages')
      .where('direction', '=', 'outbound')
      .orderBy('created_at', 'asc')
      .selectAll()
      .execute();
    expect(outboundsAll).toHaveLength(2);
    expect(outboundsAll[1].text_content).not.toContain('https://bellahair.example.com/book');
    expect(outboundsAll[1].sanitize_mods).toContain('booking_link_deduplicated');
  });
});
```

- [ ] **Step 2: Run the test**

Run: `TEST_DATABASE_URL=postgres://salon:salon@localhost:55432/salon_test TEST_REDIS_URL=redis://localhost:56379 npm run test:e2e -- 02-booking-link-dedup.spec.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/02-booking-link-dedup.spec.ts
git commit -m "test: golden e2e #2 booking link dedup across turns"
```

---

### Task 25: Golden e2e #3 — escalate_to_owner tool

**Files:**
- Create: `tests/e2e/03-escalate-tool.spec.ts`

- [ ] **Step 1: Write the test**

Write `tests/e2e/03-escalate-tool.spec.ts`:
```typescript
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDb, migrateTestDb, truncateAll } from '../helpers/test-db.js';
import { FakeLlmClient } from '../helpers/fake-llm-client.js';
import { buildTestApp } from '../helpers/test-app.js';
import * as salonsRepo from '../../src/db/repos/salons.js';

const fixturesDir = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures');

describe('e2e #3 — escalate_to_owner tool', () => {
  const db = createTestDb();
  let testApp: Awaited<ReturnType<typeof buildTestApp>>;
  let llm: FakeLlmClient;

  beforeAll(async () => { await migrateTestDb(); });
  beforeEach(async () => {
    await truncateAll(db);
    llm = new FakeLlmClient();
    testApp = await buildTestApp(db, llm);
  });
  afterAll(async () => { await testApp.shutdown(); await db.destroy(); });

  it('sets handoff, adds tag, updates field, and sends no outbound', async () => {
    const fixture = JSON.parse(readFileSync(join(fixturesDir, 'salon-bella.json'), 'utf8'));
    const salon = await salonsRepo.create(db, {
      displayName: fixture.display_name,
      ghlLocationId: fixture.ghl_location_id,
      ghlPit: fixture.ghl_pit,
      sourceOfTruth: fixture.source_of_truth,
      config: fixture.config,
    });

    llm.stage({
      match: () => true,
      output: {
        text: '',
        toolCalls: [{ id: 't1', name: 'escalate_to_owner', arguments: { reason: 'complaint' } }],
      },
    });

    await testApp.app.inject({
      method: 'POST',
      url: '/dev/simulate-inbound',
      payload: { location_id: salon.ghlLocationId, contact_id: 'c_esc', message_text: 'I want a refund' },
    });
    await new Promise((r) => setTimeout(r, 1500));

    const outbound = await db.selectFrom('messages').where('direction', '=', 'outbound').selectAll().execute();
    expect(outbound).toHaveLength(0);

    const conv = await db
      .selectFrom('conversations')
      .where('ghl_contact_id', '=', 'c_esc')
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(conv.handoff_until).not.toBeNull();
    expect((conv.handoff_until as Date).getTime()).toBeGreaterThan(Date.now());

    const escalation = await db
      .selectFrom('escalations')
      .where('conversation_id', '=', conv.id)
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(escalation.reason).toBe('complaint');
    expect(escalation.resumed_at).toBeNull();

    const state = await db
      .selectFrom('mock_contact_state')
      .where('contact_id', '=', 'c_esc')
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(state.tags).toContain('escalation_active');
    expect((state.custom_fields as Record<string, unknown>)['field_reason']).toBe('complaint');
  });
});
```

- [ ] **Step 2: Run the test**

Run: `TEST_DATABASE_URL=postgres://salon:salon@localhost:55432/salon_test TEST_REDIS_URL=redis://localhost:56379 npm run test:e2e -- 03-escalate-tool.spec.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/03-escalate-tool.spec.ts
git commit -m "test: golden e2e #3 escalate_to_owner tool sets handoff and mock GHL state"
```

---

### Task 26: Golden e2e #4 — auto-resume after timeout

**Files:**
- Create: `tests/e2e/04-auto-resume.spec.ts`

- [ ] **Step 1: Write the test (invokes auto-resume worker logic directly to avoid 5min wait)**

Write `tests/e2e/04-auto-resume.spec.ts`:
```typescript
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDb, migrateTestDb, truncateAll } from '../helpers/test-db.js';
import { FakeLlmClient } from '../helpers/fake-llm-client.js';
import { buildTestApp } from '../helpers/test-app.js';
import * as salonsRepo from '../../src/db/repos/salons.js';
import * as escalationsRepo from '../../src/db/repos/escalations.js';
import * as conversationsRepo from '../../src/db/repos/conversations.js';
import * as eventsRepo from '../../src/db/repos/events.js';

const fixturesDir = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures');

async function runAutoResumeOnce(db: Awaited<ReturnType<typeof createTestDb>>, ghl: { removeTag: (id: string, tags: string[]) => Promise<void> }) {
  const items = await escalationsRepo.listActiveTimedOut(db, new Date());
  for (const item of items) {
    await escalationsRepo.markResumed(db, item.escalationId, 'auto_timeout');
    await conversationsRepo.setHandoffUntil(db, item.conversationId, null);
    await ghl.removeTag(item.contactId, ['escalation_active']);
    await eventsRepo.insert(db, item.conversationId, 'bot_resumed', { by: 'auto_timeout' });
  }
}

describe('e2e #4 — auto-resume after timeout', () => {
  const db = createTestDb();
  let testApp: Awaited<ReturnType<typeof buildTestApp>>;

  beforeAll(async () => { await migrateTestDb(); });
  beforeEach(async () => {
    await truncateAll(db);
    testApp = await buildTestApp(db, new FakeLlmClient());
  });
  afterAll(async () => { await testApp.shutdown(); await db.destroy(); });

  it('clears handoff, removes tag, records event when handoff_until in past', async () => {
    const fixture = JSON.parse(readFileSync(join(fixturesDir, 'salon-bella.json'), 'utf8'));
    const salon = await salonsRepo.create(db, {
      displayName: fixture.display_name,
      ghlLocationId: fixture.ghl_location_id,
      ghlPit: fixture.ghl_pit,
      sourceOfTruth: fixture.source_of_truth,
      config: fixture.config,
    });

    const conv = await conversationsRepo.findOrCreate(db, salon.id, 'c_auto', null);
    const past = new Date(Date.now() - 60_000);
    await conversationsRepo.setHandoffUntil(db, conv.id, past);
    await escalationsRepo.upsertActive(db, conv.id, 'whatever', null);
    await testApp.ghl.addTag('c_auto', ['escalation_active']);

    await runAutoResumeOnce(db, testApp.ghl);

    const convAfter = await db.selectFrom('conversations').where('id', '=', conv.id).selectAll().executeTakeFirstOrThrow();
    expect(convAfter.handoff_until).toBeNull();

    const esc = await db.selectFrom('escalations').where('conversation_id', '=', conv.id).selectAll().executeTakeFirstOrThrow();
    expect(esc.resumed_at).not.toBeNull();
    expect(esc.resumed_by).toBe('auto_timeout');

    const state = await db.selectFrom('mock_contact_state').where('contact_id', '=', 'c_auto').selectAll().executeTakeFirstOrThrow();
    expect(state.tags).not.toContain('escalation_active');

    const events = await db.selectFrom('conversation_events').where('event_type', '=', 'bot_resumed').selectAll().execute();
    expect(events).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the test**

Run: `TEST_DATABASE_URL=postgres://salon:salon@localhost:55432/salon_test TEST_REDIS_URL=redis://localhost:56379 npm run test:e2e -- 04-auto-resume.spec.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/04-auto-resume.spec.ts
git commit -m "test: golden e2e #4 auto-resume clears state and removes tag"
```

---

### Task 27: Golden e2e #5 — idempotent inbound + sanitizer empty escalates

**Files:**
- Create: `tests/e2e/05-idempotent-and-empty.spec.ts`

- [ ] **Step 1: Write the test**

Write `tests/e2e/05-idempotent-and-empty.spec.ts`:
```typescript
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDb, migrateTestDb, truncateAll } from '../helpers/test-db.js';
import { FakeLlmClient } from '../helpers/fake-llm-client.js';
import { buildTestApp } from '../helpers/test-app.js';
import * as salonsRepo from '../../src/db/repos/salons.js';

const fixturesDir = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures');

describe('e2e #5 — idempotent inbound and sanitizer empty escalates', () => {
  const db = createTestDb();
  let testApp: Awaited<ReturnType<typeof buildTestApp>>;
  let llm: FakeLlmClient;

  beforeAll(async () => { await migrateTestDb(); });
  beforeEach(async () => {
    await truncateAll(db);
    llm = new FakeLlmClient();
    testApp = await buildTestApp(db, llm);
  });
  afterAll(async () => { await testApp.shutdown(); await db.destroy(); });

  it('duplicate ghl_message_id ingested only once', async () => {
    const fixture = JSON.parse(readFileSync(join(fixturesDir, 'salon-bella.json'), 'utf8'));
    const salon = await salonsRepo.create(db, {
      displayName: fixture.display_name,
      ghlLocationId: fixture.ghl_location_id,
      ghlPit: fixture.ghl_pit,
      sourceOfTruth: fixture.source_of_truth,
      config: fixture.config,
    });

    llm.stage({ match: () => true, output: { text: 'Hi!' } });

    const payload = {
      location_id: salon.ghlLocationId,
      contact_id: 'c_idem',
      message_text: 'hi',
      message_id: 'msg_dup_1',
    };
    await testApp.app.inject({ method: 'POST', url: '/dev/simulate-inbound', payload });
    await new Promise((r) => setTimeout(r, 200));
    await testApp.app.inject({ method: 'POST', url: '/dev/simulate-inbound', payload });
    await new Promise((r) => setTimeout(r, 1500));

    const inbounds = await db.selectFrom('messages').where('direction', '=', 'inbound').selectAll().execute();
    expect(inbounds).toHaveLength(1);
  });

  it('LLM output that sanitizes to empty triggers escalation', async () => {
    const fixture = JSON.parse(readFileSync(join(fixturesDir, 'salon-bella.json'), 'utf8'));
    const salon = await salonsRepo.create(db, {
      displayName: fixture.display_name,
      ghlLocationId: fixture.ghl_location_id,
      ghlPit: fixture.ghl_pit,
      sourceOfTruth: fixture.source_of_truth,
      config: fixture.config,
    });

    // LLM returns ONLY emojis beyond cap; sanitizer strips down to empty after caps
    // and whitespace cleanup is not enough. We use ellipses + punctuation that get fully stripped.
    llm.stage({ match: () => true, output: { text: '………' } });

    await testApp.app.inject({
      method: 'POST',
      url: '/dev/simulate-inbound',
      payload: { location_id: salon.ghlLocationId, contact_id: 'c_empty', message_text: 'hello' },
    });
    await new Promise((r) => setTimeout(r, 1500));

    const outbound = await db.selectFrom('messages').where('direction', '=', 'outbound').selectAll().execute();
    expect(outbound).toHaveLength(0);

    const conv = await db.selectFrom('conversations').where('ghl_contact_id', '=', 'c_empty').selectAll().executeTakeFirstOrThrow();
    expect(conv.handoff_until).not.toBeNull();

    const esc = await db.selectFrom('escalations').where('conversation_id', '=', conv.id).selectAll().executeTakeFirstOrThrow();
    expect(esc.reason).toBe('sanitizer_empty_output');
  });
});
```

- [ ] **Step 2: Run the test**

Run: `TEST_DATABASE_URL=postgres://salon:salon@localhost:55432/salon_test TEST_REDIS_URL=redis://localhost:56379 npm run test:e2e -- 05-idempotent-and-empty.spec.ts`
Expected: PASS for both cases.

- [ ] **Step 3: Run all tests together**

Run: `TEST_DATABASE_URL=postgres://salon:salon@localhost:55432/salon_test TEST_REDIS_URL=redis://localhost:56379 npm run test`
Expected: ALL pass — sanitizer unit + property + 5 e2e.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/05-idempotent-and-empty.spec.ts
git commit -m "test: golden e2e #5 idempotent inbound and sanitizer empty escalation"
```

---

### Task 28: GitHub Actions CI workflow

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Create workflow**

Write `.github/workflows/ci.yml`:
```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest

    services:
      postgres:
        image: postgres:15-alpine
        env:
          POSTGRES_USER: salon
          POSTGRES_PASSWORD: salon
          POSTGRES_DB: salon_test
        ports:
          - 55432:5432
        options: >-
          --health-cmd "pg_isready -U salon"
          --health-interval 5s
          --health-timeout 5s
          --health-retries 5

      redis:
        image: redis:7-alpine
        ports:
          - 56379:6379
        options: >-
          --health-cmd "redis-cli ping"
          --health-interval 5s
          --health-timeout 5s
          --health-retries 5

    env:
      TEST_DATABASE_URL: postgres://salon:salon@localhost:55432/salon_test
      TEST_REDIS_URL: redis://localhost:56379

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'

      - run: npm ci

      - name: Lint (typecheck)
        run: npm run lint

      - name: Run migrations on test DB
        run: npx tsx -e "import('./tests/helpers/test-db.js').then(m => m.migrateTestDb()).then(() => process.exit(0))"

      - name: Run tests
        run: npm run test
```

- [ ] **Step 2: Verify tests pass locally one more time**

Run:
```bash
TEST_DATABASE_URL=postgres://salon:salon@localhost:55432/salon_test \
TEST_REDIS_URL=redis://localhost:56379 \
  npm run test
```
Expected: ALL pass.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: GitHub Actions workflow runs typecheck + migrations + all tests"
```

---

## Definition of Done

V1 mock fundament je gotov kad:

- [ ] `npm run test` zelen — sanitizer unit + property (4000+ iter) + 5 e2e prolaze
- [ ] `npm run lint` zelen
- [ ] CI workflow zelen na push-u
- [ ] Manual smoke skripta iz README-a radi protiv `loc_bella` salona — odgovor stiže za <50s
- [ ] 3-poruke-burst test pokazuje samo 1 outbound (coalescing radi)
- [ ] `MockGhlClient` zapisuje sve outbound u `mock_outbound_log` i sve tag/field promjene u `mock_contact_state`
- [ ] Escalation lifecycle test: ručna SQL injekcija handoff_until u prošlosti → auto-resume worker očisti za <5min
- [ ] `POST /webhooks/ghl/resume` resetira handoff i bot opet odgovara na sljedeći inbound

Switch na real GHL u kasnijoj fazi: zamijeniti `new MockGhlClient(db)` u `src/index.ts` s `new RealGhlClient({ pit, locationId })`. Sanitizer, prompt, conversation engine, escalation flow, sve testovi ostaju netaknuti.
