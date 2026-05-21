# Instagram Image Handling V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dodati multimodalnu (vision) obradu slika koje klijenti šalju kroz Instagram DM-ove, uz hard-escalation prečace za video i audio.

**Architecture:** Backend fetcha attachment URL → sharp kompresira → base64 → ulazi u multimodalan `LlmClient` interface kao `ContentBlock[]`. Provider klijenti (Anthropic / OpenAI / Gemini) mapiraju content blocks u svoj API format. Sve slike iz zadnjih 15 inbound poruka ulaze u svaki LLM poziv (oslanjamo se na OpenAI auto-cache). Video/audio/image-bez-URL-a escaliraju s canned reassurance porukom bez LLM poziva.

**Tech Stack:** TypeScript + Fastify + Kysely + Postgres + BullMQ + sharp (nova dep) + vitest

**Predecessor spec:** [`docs/superpowers/specs/2026-05-20-instagram-image-handling-v1-design.md`](../specs/2026-05-20-instagram-image-handling-v1-design.md)

---

## Task 1: Foundation — sharp, image errors, config schema

**Files:**
- Modify: `package.json`
- Create: `src/images/errors.ts`
- Modify: `src/core/salon-config-schema.ts`
- Create: `tests/unit/images/errors.spec.ts`
- Modify: `tests/unit/config.spec.ts`

- [ ] **Step 1: Install sharp**

```bash
npm install sharp@^0.33.0
```

Verify install:
```bash
npm ls sharp
```
Expected: `sharp@0.33.x` in output, no warnings.

- [ ] **Step 2: Write failing test for image errors**

Create `tests/unit/images/errors.spec.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import {
  AttachmentFetchError,
  UnsupportedImageFormatError,
  ImageTooLargeError,
} from '../../../src/images/errors.js';

describe('image error classes', () => {
  it('AttachmentFetchError preserves status and url', () => {
    const err = new AttachmentFetchError(404, 'https://x.test/img');
    expect(err.name).toBe('AttachmentFetchError');
    expect(err.status).toBe(404);
    expect(err.url).toBe('https://x.test/img');
    expect(err.message).toContain('404');
  });

  it('UnsupportedImageFormatError preserves format', () => {
    const err = new UnsupportedImageFormatError('heif');
    expect(err.name).toBe('UnsupportedImageFormatError');
    expect(err.format).toBe('heif');
  });

  it('ImageTooLargeError preserves bytes', () => {
    const err = new ImageTooLargeError(6_000_000);
    expect(err.name).toBe('ImageTooLargeError');
    expect(err.bytes).toBe(6_000_000);
  });
});
```

- [ ] **Step 3: Run test — expect FAIL** (module does not yet exist)

Run: `npx vitest run tests/unit/images/errors.spec.ts`
Expected: `Cannot find module '.../src/images/errors.js'`.

- [ ] **Step 4: Create image errors module**

Create `src/images/errors.ts`:
```typescript
export class AttachmentFetchError extends Error {
  constructor(public readonly status: number, public readonly url: string) {
    super(`Attachment fetch failed (status ${status}) for ${url}`);
    this.name = 'AttachmentFetchError';
  }
}

export class UnsupportedImageFormatError extends Error {
  constructor(public readonly format: string) {
    super(`Unsupported image format: ${format}`);
    this.name = 'UnsupportedImageFormatError';
  }
}

export class ImageTooLargeError extends Error {
  constructor(public readonly bytes: number) {
    super(`Image too large: ${bytes} bytes (max 5MB)`);
    this.name = 'ImageTooLargeError';
  }
}
```

- [ ] **Step 5: Run test — expect PASS**

Run: `npx vitest run tests/unit/images/errors.spec.ts`
Expected: 3 tests pass.

- [ ] **Step 6: Update salon config schema**

Modify `src/core/salon-config-schema.ts`. Add new sub-schema before the closing `})`:
```typescript
export const SalonConfigSchema = z.object({
  response_delay_ms: z.number().int().positive().default(40_000),
  llm_model: z.string().optional(),
  handoff_window_hours: z.number().positive().default(4),
  booking_link_dedup_window: z.number().int().positive().default(3),
  max_words_per_message: z.number().int().positive().default(40),
  max_emojis: z.number().int().nonnegative().default(2),
  ghl_custom_field_ids: z.object({
    needs_owner_attention: z.string(),
    bot_paused_until: z.string(),
    last_escalation_reason: z.string(),
  }),
  image_processing: z
    .object({
      enabled: z.boolean().default(true),
      max_dimension: z.number().int().min(512).max(2048).default(1280),
      jpeg_quality: z.number().int().min(40).max(95).default(80),
    })
    .default({}),
});
```

- [ ] **Step 7: Write failing test for config defaults**

Read existing `tests/unit/config.spec.ts` first to understand the file's structure. Then append:
```typescript
import { SalonConfigSchema } from '../../src/core/salon-config-schema.js';

describe('SalonConfigSchema image_processing defaults', () => {
  const minimalConfig = {
    ghl_custom_field_ids: {
      needs_owner_attention: 'a',
      bot_paused_until: 'b',
      last_escalation_reason: 'c',
    },
  };

  it('applies defaults when image_processing field is missing', () => {
    const parsed = SalonConfigSchema.parse(minimalConfig);
    expect(parsed.image_processing).toEqual({
      enabled: true,
      max_dimension: 1280,
      jpeg_quality: 80,
    });
  });

  it('respects partial overrides', () => {
    const parsed = SalonConfigSchema.parse({
      ...minimalConfig,
      image_processing: { enabled: false },
    });
    expect(parsed.image_processing).toEqual({
      enabled: false,
      max_dimension: 1280,
      jpeg_quality: 80,
    });
  });

  it('rejects out-of-range max_dimension', () => {
    expect(() =>
      SalonConfigSchema.parse({
        ...minimalConfig,
        image_processing: { max_dimension: 4096 },
      }),
    ).toThrow();
  });
});
```

- [ ] **Step 8: Run test — expect PASS**

Run: `npx vitest run tests/unit/config.spec.ts`
Expected: new 3 tests pass, plus any existing tests in that file still pass.

- [ ] **Step 9: Build check**

Run: `npm run build`
Expected: clean compile, no TS errors.

- [ ] **Step 10: Commit**

```bash
git add package.json package-lock.json src/images/errors.ts src/core/salon-config-schema.ts tests/unit/images/errors.spec.ts tests/unit/config.spec.ts
git commit -m "feat(images): add sharp dep, error classes, image_processing config schema"
```

---

## Task 2: Image processing — processImageForVision

**Files:**
- Create: `src/images/process.ts`
- Create: `tests/unit/images/fixtures/generate-fixtures.ts` (one-off script)
- Create: `tests/unit/images/fixtures/landscape-2000x1500.jpg` (generated)
- Create: `tests/unit/images/fixtures/small-800x600.jpg` (generated)
- Create: `tests/unit/images/fixtures/portrait-with-exif.jpg` (generated)
- Create: `tests/unit/images/fixtures/simple.png` (generated)
- Create: `tests/unit/images/fixtures/animated.gif` (generated)
- Create: `tests/unit/images/fixtures/not-an-image.bin` (generated)
- Create: `tests/unit/images/process.spec.ts`

- [ ] **Step 1: Create fixture generator script**

Create `tests/unit/images/fixtures/generate-fixtures.ts`:
```typescript
// One-off script: run with `npx tsx tests/unit/images/fixtures/generate-fixtures.ts`
// Produces deterministic binary fixtures used by process.spec.ts.
import sharp from 'sharp';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  // Landscape JPEG that exceeds MAX_DIMENSION
  await sharp({
    create: { width: 2000, height: 1500, channels: 3, background: { r: 200, g: 100, b: 50 } },
  })
    .jpeg({ quality: 90 })
    .toFile(join(HERE, 'landscape-2000x1500.jpg'));

  // Small JPEG that should not be enlarged
  await sharp({
    create: { width: 800, height: 600, channels: 3, background: { r: 50, g: 150, b: 200 } },
  })
    .jpeg({ quality: 90 })
    .toFile(join(HERE, 'small-800x600.jpg'));

  // Portrait with EXIF orientation 6 (rotate 90deg CW = swap dims after .rotate())
  // We create as landscape, then write EXIF orientation marker so sharp's .rotate() flips it.
  await sharp({
    create: { width: 1200, height: 800, channels: 3, background: { r: 100, g: 200, b: 100 } },
  })
    .jpeg({ quality: 90 })
    .withMetadata({ exif: { IFD0: { Orientation: '6' } as Record<string, string> } })
    .toFile(join(HERE, 'portrait-with-exif.jpg'));

  // Simple PNG with alpha
  await sharp({
    create: { width: 600, height: 400, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.5 } },
  })
    .png()
    .toFile(join(HERE, 'simple.png'));

  // Animated GIF with two frames — sharp creates animated GIF when input has 'pages'
  const frame1 = await sharp({
    create: { width: 400, height: 400, channels: 3, background: { r: 255, g: 0, b: 0 } },
  })
    .raw()
    .toBuffer();
  const frame2 = await sharp({
    create: { width: 400, height: 400, channels: 3, background: { r: 0, g: 255, b: 0 } },
  })
    .raw()
    .toBuffer();
  await sharp(Buffer.concat([frame1, frame2]), {
    raw: { width: 400, height: 800, channels: 3 },
    pages: 2,
    pageHeight: 400,
  })
    .gif()
    .toFile(join(HERE, 'animated.gif'));

  // Random bytes that are not any image format
  writeFileSync(join(HERE, 'not-an-image.bin'), Buffer.from('this is just text, not an image'));

  console.log('Fixtures generated in', HERE);
}

void main();
```

- [ ] **Step 2: Run the generator**

```bash
npx tsx tests/unit/images/fixtures/generate-fixtures.ts
```
Expected: prints "Fixtures generated in …", creates 6 files.

Verify files exist:
```bash
ls tests/unit/images/fixtures/
```
Expected: `landscape-2000x1500.jpg`, `small-800x600.jpg`, `portrait-with-exif.jpg`, `simple.png`, `animated.gif`, `not-an-image.bin`, plus the generator script.

- [ ] **Step 3: Write failing test for processImageForVision**

Create `tests/unit/images/process.spec.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { processImageForVision } from '../../../src/images/process.js';
import { UnsupportedImageFormatError } from '../../../src/images/errors.js';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const read = (name: string): Buffer => readFileSync(join(FIX, name));

describe('processImageForVision', () => {
  it('resizes landscape JPEG when longer side exceeds 1280', async () => {
    const out = await processImageForVision(read('landscape-2000x1500.jpg'));
    expect(out.mediaType).toBe('image/jpeg');
    expect(out.width).toBe(1280);
    expect(out.height).toBe(960);
    expect(out.bytesOut).toBeLessThan(out.bytesIn);
    expect(out.base64.length).toBeGreaterThan(0);
  });

  it('does not enlarge small JPEG below 1280', async () => {
    const out = await processImageForVision(read('small-800x600.jpg'));
    expect(out.width).toBe(800);
    expect(out.height).toBe(600);
  });

  it('converts PNG input to JPEG output', async () => {
    const out = await processImageForVision(read('simple.png'));
    expect(out.mediaType).toBe('image/jpeg');
  });

  it('extracts first frame from animated GIF', async () => {
    const out = await processImageForVision(read('animated.gif'));
    expect(out.mediaType).toBe('image/jpeg');
    expect(out.width).toBe(400);
    expect(out.height).toBe(400);
  });

  it('applies EXIF orientation 6 (rotates 90deg CW)', async () => {
    const out = await processImageForVision(read('portrait-with-exif.jpg'));
    // Original 1200x800 landscape with EXIF orientation 6 should rotate to 800x1200 portrait
    expect(out.width).toBe(800);
    expect(out.height).toBe(1200);
  });

  it('throws UnsupportedImageFormatError for SVG', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"/>', 'utf-8');
    await expect(processImageForVision(svg)).rejects.toBeInstanceOf(UnsupportedImageFormatError);
  });

  it('throws UnsupportedImageFormatError for non-image bytes', async () => {
    await expect(processImageForVision(read('not-an-image.bin'))).rejects.toBeInstanceOf(
      UnsupportedImageFormatError,
    );
  });
});
```

- [ ] **Step 4: Run test — expect FAIL** (module does not yet exist)

Run: `npx vitest run tests/unit/images/process.spec.ts`
Expected: errors saying `Cannot find module '.../src/images/process.js'`.

- [ ] **Step 5: Implement processImageForVision**

Create `src/images/process.ts`:
```typescript
import sharp from 'sharp';
import { UnsupportedImageFormatError } from './errors.js';

const MAX_DIMENSION = 1280;
const JPEG_QUALITY = 80;
const ALLOWED_INPUT_FORMATS = new Set(['jpeg', 'jpg', 'png', 'gif', 'webp']);

export interface ProcessedImage {
  base64: string;
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp';
  width: number;
  height: number;
  bytesIn: number;
  bytesOut: number;
}

export async function processImageForVision(input: Buffer): Promise<ProcessedImage> {
  let format: string | undefined;
  try {
    const meta = await sharp(input).metadata();
    format = meta.format;
  } catch {
    throw new UnsupportedImageFormatError('unknown');
  }

  if (!format || !ALLOWED_INPUT_FORMATS.has(format)) {
    throw new UnsupportedImageFormatError(format ?? 'unknown');
  }

  const out = await sharp(input, { animated: false })
    .rotate()
    .resize({
      width: MAX_DIMENSION,
      height: MAX_DIMENSION,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });

  return {
    base64: out.data.toString('base64'),
    mediaType: 'image/jpeg',
    width: out.info.width,
    height: out.info.height,
    bytesIn: input.length,
    bytesOut: out.data.length,
  };
}
```

Note: `{ animated: false }` tells sharp to read only first frame of animated GIF, satisfying that test case.

- [ ] **Step 6: Run test — expect PASS**

Run: `npx vitest run tests/unit/images/process.spec.ts`
Expected: 7 tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/images/process.ts tests/unit/images/process.spec.ts tests/unit/images/fixtures/
git commit -m "feat(images): processImageForVision with sharp resize+compress"
```

---

## Task 3: Image fetch — fetchAttachment

**Files:**
- Create: `src/images/fetch.ts`
- Create: `tests/unit/images/fetch.spec.ts`

- [ ] **Step 1: Write failing test**

Create `tests/unit/images/fetch.spec.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { fetchAttachment } from '../../../src/images/fetch.js';
import { AttachmentFetchError, ImageTooLargeError } from '../../../src/images/errors.js';

function mockResponse(status: number, body: Uint8Array | string = '', headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers });
}

describe('fetchAttachment', () => {
  it('returns buffer on plain 200', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const fetcher: typeof fetch = async () => mockResponse(200, bytes, { 'content-length': '4' });
    const buf = await fetchAttachment('https://x.test/img.jpg', 'pit-xyz', fetcher);
    expect(buf).toEqual(Buffer.from(bytes));
  });

  it('retries with Bearer header on 401 and succeeds', async () => {
    const calls: { url: string; auth?: string }[] = [];
    const bytes = new Uint8Array([9, 9]);
    const fetcher: typeof fetch = async (url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ url: String(url), auth: headers['Authorization'] });
      if (calls.length === 1) return mockResponse(401);
      return mockResponse(200, bytes, { 'content-length': '2' });
    };
    const buf = await fetchAttachment('https://x.test/img.jpg', 'pit-xyz', fetcher);
    expect(calls).toHaveLength(2);
    expect(calls[0].auth).toBeUndefined();
    expect(calls[1].auth).toBe('Bearer pit-xyz');
    expect(buf).toEqual(Buffer.from(bytes));
  });

  it('throws AttachmentFetchError when both attempts fail', async () => {
    const fetcher: typeof fetch = async () => mockResponse(403);
    await expect(fetchAttachment('https://x.test/img.jpg', 'pit', fetcher)).rejects.toBeInstanceOf(
      AttachmentFetchError,
    );
  });

  it('throws AttachmentFetchError on 404 without retry', async () => {
    let calls = 0;
    const fetcher: typeof fetch = async () => {
      calls++;
      return mockResponse(404);
    };
    await expect(fetchAttachment('https://x.test/img.jpg', 'pit', fetcher)).rejects.toBeInstanceOf(
      AttachmentFetchError,
    );
    expect(calls).toBe(1);
  });

  it('throws ImageTooLargeError when Content-Length exceeds cap', async () => {
    const fetcher: typeof fetch = async () =>
      mockResponse(200, new Uint8Array(0), { 'content-length': String(6 * 1024 * 1024) });
    await expect(fetchAttachment('https://x.test/big.jpg', 'pit', fetcher)).rejects.toBeInstanceOf(
      ImageTooLargeError,
    );
  });

  it('throws ImageTooLargeError when actual buffer exceeds cap even if Content-Length is small/missing', async () => {
    const huge = new Uint8Array(6 * 1024 * 1024 + 1);
    const fetcher: typeof fetch = async () => mockResponse(200, huge);
    await expect(fetchAttachment('https://x.test/big.jpg', 'pit', fetcher)).rejects.toBeInstanceOf(
      ImageTooLargeError,
    );
  });
});
```

- [ ] **Step 2: Run test — expect FAIL** (module does not yet exist)

Run: `npx vitest run tests/unit/images/fetch.spec.ts`
Expected: errors saying `Cannot find module '.../src/images/fetch.js'`.

- [ ] **Step 3: Implement fetchAttachment**

Create `src/images/fetch.ts`:
```typescript
import { AttachmentFetchError, ImageTooLargeError } from './errors.js';

const MAX_INPUT_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10_000;

type Fetcher = typeof fetch;

export async function fetchAttachment(url: string, pit: string, fetcher: Fetcher = fetch): Promise<Buffer> {
  let res = await fetcher(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });

  if (!res.ok && (res.status === 401 || res.status === 403)) {
    res = await fetcher(url, {
      headers: { Authorization: `Bearer ${pit}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  }

  if (!res.ok) {
    throw new AttachmentFetchError(res.status, url);
  }

  const declared = parseInt(res.headers.get('content-length') ?? '0', 10);
  if (declared > MAX_INPUT_BYTES) {
    throw new ImageTooLargeError(declared);
  }

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_INPUT_BYTES) {
    throw new ImageTooLargeError(buf.length);
  }
  return buf;
}
```

- [ ] **Step 4: Run test — expect PASS**

Run: `npx vitest run tests/unit/images/fetch.spec.ts`
Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/images/fetch.ts tests/unit/images/fetch.spec.ts
git commit -m "feat(images): fetchAttachment with defensive auth retry"
```

---

## Task 4: extractImageAttachments helper

**Files:**
- Create: `src/images/extract-attachments.ts`
- Create: `tests/unit/images/extract-attachments.spec.ts`

- [ ] **Step 1: Write failing test**

Create `tests/unit/images/extract-attachments.spec.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { extractImageAttachments } from '../../../src/images/extract-attachments.js';

describe('extractImageAttachments', () => {
  it('extracts image attachments with URLs from raw_content', () => {
    const raw = {
      location_id: 'loc',
      contact_id: 'c',
      attachments: [
        { url: 'https://x.test/a.jpg', type: 'image' },
        { url: 'https://x.test/b.png', type: 'image' },
      ],
    };
    expect(extractImageAttachments(raw)).toEqual([
      { url: 'https://x.test/a.jpg' },
      { url: 'https://x.test/b.png' },
    ]);
  });

  it('skips non-image types', () => {
    const raw = {
      attachments: [
        { url: 'https://x.test/v.mp4', type: 'video' },
        { url: 'https://x.test/a.jpg', type: 'image' },
        { url: 'https://x.test/x.mp3', type: 'audio' },
      ],
    };
    expect(extractImageAttachments(raw)).toEqual([{ url: 'https://x.test/a.jpg' }]);
  });

  it('skips images without URL', () => {
    const raw = {
      attachments: [
        { url: 'https://x.test/a.jpg', type: 'image' },
        { url: null, type: 'image' },
        { type: 'image' },
      ],
    };
    expect(extractImageAttachments(raw)).toEqual([{ url: 'https://x.test/a.jpg' }]);
  });

  it('returns empty array when no attachments field', () => {
    expect(extractImageAttachments({ location_id: 'loc' })).toEqual([]);
  });

  it('returns empty array for null/undefined input', () => {
    expect(extractImageAttachments(null)).toEqual([]);
    expect(extractImageAttachments(undefined)).toEqual([]);
  });

  it('returns empty array when input is not an object', () => {
    expect(extractImageAttachments('not an object')).toEqual([]);
    expect(extractImageAttachments(42)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

Run: `npx vitest run tests/unit/images/extract-attachments.spec.ts`
Expected: errors saying `Cannot find module`.

- [ ] **Step 3: Implement extractImageAttachments**

Create `src/images/extract-attachments.ts`:
```typescript
export interface ExtractedImageAttachment {
  url: string;
}

export function extractImageAttachments(rawContent: unknown): ExtractedImageAttachment[] {
  if (!rawContent || typeof rawContent !== 'object') return [];
  const atts = (rawContent as { attachments?: unknown }).attachments;
  if (!Array.isArray(atts)) return [];

  const result: ExtractedImageAttachment[] = [];
  for (const att of atts) {
    if (!att || typeof att !== 'object') continue;
    const a = att as { url?: unknown; type?: unknown };
    if (a.type !== 'image') continue;
    if (typeof a.url !== 'string' || a.url.length === 0) continue;
    result.push({ url: a.url });
  }
  return result;
}
```

- [ ] **Step 4: Run test — expect PASS**

Run: `npx vitest run tests/unit/images/extract-attachments.spec.ts`
Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/images/extract-attachments.ts tests/unit/images/extract-attachments.spec.ts
git commit -m "feat(images): extractImageAttachments helper for raw_content parsing"
```

---

## Task 5: ContentBlock + LlmClient interface change

**Files:**
- Modify: `src/llm/client.ts`
- Modify: `tests/helpers/fake-llm-client.ts` (compat check, no logic change needed)

- [ ] **Step 1: Update LlmClient interface and add ContentBlock type**

Replace contents of `src/llm/client.ts`:
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

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: 'image/jpeg' | 'image/png' | 'image/webp'; base64: string };

export interface LlmCompleteInput {
  systemPrompt: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string | ContentBlock[] }>;
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

/** Korak 1 stub. Replaced with provider-specific clients in Korak 4. Kept for reference. */
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

- [ ] **Step 2: Build check — expect FAIL in provider files**

Run: `npm run build`
Expected: TS errors in `src/llm/anthropic.ts`, `openai.ts`, `gemini.ts` (they pass `m.content` directly assuming it's always string). These will be fixed in Tasks 6, 7, 8.

If FakeLlmClient does NOT show TS errors, proceed. If it does (its `match` callback receiving the new type), update its `match` signature — but it already takes `LlmCompleteInput`, so should be fine.

- [ ] **Step 3: Run existing LLM tests — they should still pass**

These tests likely don't exist yet for providers, but a smoke check that types compile in isolation:
```bash
npx vitest run tests/unit/
```
Expected: errors only in tests/integration of llm if they call provider clients with image content. Existing tests using string content should still pass.

Note: this Task introduces a transient build break (provider files don't yet handle ContentBlock[]). Subsequent tasks fix each provider.

- [ ] **Step 4: Commit (with known transient build break)**

```bash
git add src/llm/client.ts
git commit -m "feat(llm): introduce ContentBlock type and multimodal LlmCompleteInput

Provider implementations updated in follow-up commits."
```

---

## Task 6: Anthropic provider — multimodal mapper

**Files:**
- Modify: `src/llm/anthropic.ts`
- Create: `tests/unit/llm/anthropic.spec.ts`

- [ ] **Step 1: Write failing test**

Create `tests/unit/llm/anthropic.spec.ts`:
```typescript
import { describe, it, expect, vi } from 'vitest';
import { AnthropicLlmClient } from '../../../src/llm/anthropic.js';

// We can't easily mock the SDK transport, so we test the mapping by stubbing the create method.
function makeClient(): { client: AnthropicLlmClient; create: ReturnType<typeof vi.fn> } {
  const client = new AnthropicLlmClient('test-key');
  const create = vi.fn(async () => ({
    content: [{ type: 'text', text: 'ok' }],
    usage: { input_tokens: 1, output_tokens: 1 },
  }));
  // @ts-expect-error — reach into private to swap SDK
  client.client = { messages: { create } };
  return { client, create };
}

describe('AnthropicLlmClient mapping', () => {
  it('passes string content through unchanged', async () => {
    const { client, create } = makeClient();
    await client.complete({
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      model: 'claude-opus-4-7',
      maxTokens: 100,
    });
    expect(create).toHaveBeenCalledOnce();
    const arg = create.mock.calls[0][0] as { messages: Array<{ role: string; content: unknown }> };
    expect(arg.messages[0]).toEqual({ role: 'user', content: 'hello' });
  });

  it('maps ContentBlock[] with image+text into Anthropic content array', async () => {
    const { client, create } = makeClient();
    await client.complete({
      systemPrompt: 'sys',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', mediaType: 'image/jpeg', base64: 'AAAA' },
            { type: 'text', text: 'check this' },
          ],
        },
      ],
      tools: [],
      model: 'claude-opus-4-7',
      maxTokens: 100,
    });
    const arg = create.mock.calls[0][0] as { messages: Array<{ role: string; content: unknown }> };
    expect(arg.messages[0]).toEqual({
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } },
        { type: 'text', text: 'check this' },
      ],
    });
  });
});
```

- [ ] **Step 2: Run test — expect FAIL** (still uses old mapping)

Run: `npx vitest run tests/unit/llm/anthropic.spec.ts`
Expected: second test fails because `messages[0]` is sent as `{ role, content: ContentBlock[] }` (our type) rather than Anthropic's content shape.

- [ ] **Step 3: Update Anthropic mapper**

Replace contents of `src/llm/anthropic.ts`:
```typescript
import Anthropic from '@anthropic-ai/sdk';
import type { LlmClient, LlmCompleteInput, LlmCompleteOutput, ToolCall, ContentBlock } from './client.js';

export class AnthropicLlmClient implements LlmClient {
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey, timeout: 30_000, maxRetries: 0 });
  }

  async complete(input: LlmCompleteInput): Promise<LlmCompleteOutput> {
    const response = await this.client.messages.create({
      model: input.model,
      max_tokens: input.maxTokens,
      system: input.systemPrompt,
      messages: input.messages.map((m) => ({
        role: m.role,
        content: typeof m.content === 'string' ? m.content : m.content.map(mapBlock),
      })),
      tools:
        input.tools.length > 0
          ? input.tools.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: t.input_schema as Anthropic.Tool.InputSchema,
            }))
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

function mapBlock(b: ContentBlock): Anthropic.Messages.ContentBlockParam {
  if (b.type === 'text') return { type: 'text', text: b.text };
  return {
    type: 'image',
    source: { type: 'base64', media_type: b.mediaType, data: b.base64 },
  };
}
```

- [ ] **Step 4: Run test — expect PASS**

Run: `npx vitest run tests/unit/llm/anthropic.spec.ts`
Expected: 2 tests pass.

- [ ] **Step 5: Build check**

Run: `npm run build`
Expected: anthropic.ts compiles clean. openai.ts and gemini.ts still error (fixed in next tasks).

- [ ] **Step 6: Commit**

```bash
git add src/llm/anthropic.ts tests/unit/llm/anthropic.spec.ts
git commit -m "feat(llm): map ContentBlock[] to Anthropic image+text content"
```

---

## Task 7: OpenAI provider — multimodal mapper

**Files:**
- Modify: `src/llm/openai.ts`
- Create: `tests/unit/llm/openai.spec.ts`

- [ ] **Step 1: Write failing test**

Create `tests/unit/llm/openai.spec.ts`:
```typescript
import { describe, it, expect, vi } from 'vitest';
import { OpenAiLlmClient } from '../../../src/llm/openai.js';

function makeClient(): { client: OpenAiLlmClient; create: ReturnType<typeof vi.fn> } {
  const client = new OpenAiLlmClient('test-key');
  const create = vi.fn(async () => ({
    choices: [{ message: { content: 'ok', tool_calls: [] } }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  }));
  // @ts-expect-error — swap SDK
  client.client = { chat: { completions: { create } } };
  return { client, create };
}

describe('OpenAiLlmClient mapping', () => {
  it('passes string content through unchanged', async () => {
    const { client, create } = makeClient();
    await client.complete({
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      model: 'gpt-4o',
      maxTokens: 100,
    });
    const arg = create.mock.calls[0][0] as { messages: Array<{ role: string; content: unknown }> };
    expect(arg.messages[0]).toEqual({ role: 'system', content: 'sys' });
    expect(arg.messages[1]).toEqual({ role: 'user', content: 'hello' });
  });

  it('maps ContentBlock[] with image+text to OpenAI multipart format', async () => {
    const { client, create } = makeClient();
    await client.complete({
      systemPrompt: 'sys',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', mediaType: 'image/jpeg', base64: 'AAAA' },
            { type: 'text', text: 'check this' },
          ],
        },
      ],
      tools: [],
      model: 'gpt-4o',
      maxTokens: 100,
    });
    const arg = create.mock.calls[0][0] as { messages: Array<{ role: string; content: unknown }> };
    expect(arg.messages[1]).toEqual({
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } },
        { type: 'text', text: 'check this' },
      ],
    });
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

Run: `npx vitest run tests/unit/llm/openai.spec.ts`
Expected: image test fails because content array is passed through unchanged.

- [ ] **Step 3: Update OpenAI mapper**

Replace contents of `src/llm/openai.ts`:
```typescript
import OpenAI from 'openai';
import type { LlmClient, LlmCompleteInput, LlmCompleteOutput, ToolCall, ContentBlock } from './client.js';

export class OpenAiLlmClient implements LlmClient {
  private client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey, timeout: 30_000, maxRetries: 0 });
  }

  async complete(input: LlmCompleteInput): Promise<LlmCompleteOutput> {
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: 'system', content: input.systemPrompt },
      ...input.messages.map((m) => {
        if (typeof m.content === 'string') {
          return { role: m.role, content: m.content } as OpenAI.Chat.Completions.ChatCompletionMessageParam;
        }
        return {
          role: m.role,
          content: m.content.map(mapBlock),
        } as OpenAI.Chat.Completions.ChatCompletionMessageParam;
      }),
    ];

    const tools: OpenAI.Chat.Completions.ChatCompletionTool[] | undefined =
      input.tools.length > 0
        ? input.tools.map((t) => ({
            type: 'function' as const,
            function: {
              name: t.name,
              description: t.description,
              parameters: t.input_schema as Record<string, unknown>,
            },
          }))
        : undefined;

    const response = await this.client.chat.completions.create({
      model: input.model,
      messages,
      tools,
      max_tokens: input.maxTokens,
    });

    const choice = response.choices[0];
    const text = choice.message.content ?? '';
    const toolCalls: ToolCall[] = (choice.message.tool_calls ?? []).map((tc) => {
      if (tc.type !== 'function') {
        return { id: tc.id, name: 'unknown', arguments: {} };
      }
      let parsedArgs: Record<string, unknown> = {};
      try {
        parsedArgs = JSON.parse(tc.function.arguments);
      } catch {
        // leave empty
      }
      return {
        id: tc.id,
        name: tc.function.name,
        arguments: parsedArgs,
      };
    });

    return {
      text,
      toolCalls,
      usage: {
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
      },
    };
  }
}

function mapBlock(b: ContentBlock): OpenAI.Chat.Completions.ChatCompletionContentPart {
  if (b.type === 'text') return { type: 'text', text: b.text };
  return {
    type: 'image_url',
    image_url: { url: `data:${b.mediaType};base64,${b.base64}` },
  };
}
```

- [ ] **Step 4: Run test — expect PASS**

Run: `npx vitest run tests/unit/llm/openai.spec.ts`
Expected: 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/llm/openai.ts tests/unit/llm/openai.spec.ts
git commit -m "feat(llm): map ContentBlock[] to OpenAI image_url multipart content"
```

---

## Task 8: Gemini provider — multimodal mapper

**Files:**
- Modify: `src/llm/gemini.ts`
- Create: `tests/unit/llm/gemini.spec.ts`

- [ ] **Step 1: Write failing test**

Create `tests/unit/llm/gemini.spec.ts`:
```typescript
import { describe, it, expect, vi } from 'vitest';
import { GeminiLlmClient } from '../../../src/llm/gemini.js';

function makeClient(): { client: GeminiLlmClient; gen: ReturnType<typeof vi.fn> } {
  const client = new GeminiLlmClient('test-key');
  const gen = vi.fn(async () => ({
    candidates: [{ content: { parts: [{ text: 'ok' }] } }],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
  }));
  // @ts-expect-error — swap SDK
  client.ai = { models: { generateContent: gen } };
  return { client, gen };
}

describe('GeminiLlmClient mapping', () => {
  it('passes string content as single text part', async () => {
    const { client, gen } = makeClient();
    await client.complete({
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      model: 'gemini-2.0-flash',
      maxTokens: 100,
    });
    const arg = gen.mock.calls[0][0] as { contents: Array<{ role: string; parts: unknown }> };
    expect(arg.contents[0]).toEqual({ role: 'user', parts: [{ text: 'hello' }] });
  });

  it('maps ContentBlock[] with image+text to Gemini parts', async () => {
    const { client, gen } = makeClient();
    await client.complete({
      systemPrompt: 'sys',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', mediaType: 'image/jpeg', base64: 'AAAA' },
            { type: 'text', text: 'check this' },
          ],
        },
      ],
      tools: [],
      model: 'gemini-2.0-flash',
      maxTokens: 100,
    });
    const arg = gen.mock.calls[0][0] as { contents: Array<{ role: string; parts: unknown }> };
    expect(arg.contents[0]).toEqual({
      role: 'user',
      parts: [
        { inlineData: { mimeType: 'image/jpeg', data: 'AAAA' } },
        { text: 'check this' },
      ],
    });
  });

  it("maps role 'assistant' to 'model'", async () => {
    const { client, gen } = makeClient();
    await client.complete({
      systemPrompt: 'sys',
      messages: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: 'a' },
      ],
      tools: [],
      model: 'gemini-2.0-flash',
      maxTokens: 100,
    });
    const arg = gen.mock.calls[0][0] as { contents: Array<{ role: string }> };
    expect(arg.contents[1].role).toBe('model');
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

Run: `npx vitest run tests/unit/llm/gemini.spec.ts`
Expected: image test fails.

- [ ] **Step 3: Update Gemini mapper**

Replace contents of `src/llm/gemini.ts`:
```typescript
import { GoogleGenAI } from '@google/genai';
import type { LlmClient, LlmCompleteInput, LlmCompleteOutput, ToolCall, ContentBlock } from './client.js';

export class GeminiLlmClient implements LlmClient {
  private ai: GoogleGenAI;

  constructor(apiKey: string) {
    this.ai = new GoogleGenAI({ apiKey });
  }

  async complete(input: LlmCompleteInput): Promise<LlmCompleteOutput> {
    const contents = input.messages.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts:
        typeof m.content === 'string'
          ? [{ text: m.content }]
          : m.content.map(mapBlock),
    }));

    const tools =
      input.tools.length > 0
        ? [
            {
              functionDeclarations: input.tools.map((t) => ({
                name: t.name,
                description: t.description,
                parametersJsonSchema: t.input_schema,
              })),
            },
          ]
        : undefined;

    const response = await this.ai.models.generateContent({
      model: input.model,
      contents,
      config: {
        systemInstruction: input.systemPrompt,
        maxOutputTokens: input.maxTokens,
        tools,
      },
    });

    const candidate = response.candidates?.[0];
    let text = '';
    const toolCalls: ToolCall[] = [];

    for (const part of candidate?.content?.parts ?? []) {
      if (typeof part.text === 'string') text += part.text;
      if (part.functionCall) {
        toolCalls.push({
          id: part.functionCall.id ?? `gemini_${toolCalls.length}`,
          name: part.functionCall.name ?? 'unknown',
          arguments: (part.functionCall.args as Record<string, unknown>) ?? {},
        });
      }
    }

    const usage = response.usageMetadata;
    return {
      text,
      toolCalls,
      usage: {
        inputTokens: usage?.promptTokenCount ?? 0,
        outputTokens: usage?.candidatesTokenCount ?? 0,
      },
    };
  }
}

function mapBlock(b: ContentBlock): { text: string } | { inlineData: { mimeType: string; data: string } } {
  if (b.type === 'text') return { text: b.text };
  return { inlineData: { mimeType: b.mediaType, data: b.base64 } };
}
```

- [ ] **Step 4: Run test — expect PASS**

Run: `npx vitest run tests/unit/llm/gemini.spec.ts`
Expected: 3 tests pass.

- [ ] **Step 5: Build check — expect FULL CLEAN BUILD**

Run: `npm run build`
Expected: 0 TS errors. (Transient break from Task 5 is now resolved.)

- [ ] **Step 6: Commit**

```bash
git add src/llm/gemini.ts tests/unit/llm/gemini.spec.ts
git commit -m "feat(llm): map ContentBlock[] to Gemini inlineData parts"
```

---

## Task 9: Expose rawContent in conversation mapper + Message type

**Files:**
- Modify: `src/core/types.ts`
- Modify: `src/db/repos/conversations.ts`

- [ ] **Step 1: Update Message type**

Modify `src/core/types.ts`. Find the `Message` interface and add `rawContent`:
```typescript
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
  rawContent: unknown;
}
```

- [ ] **Step 2: Update conversations repo mapper**

Modify `src/db/repos/conversations.ts`. Find `rowToMessage` and update both the signature and the return value:
```typescript
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
  raw_content: unknown;
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
    rawContent: row.raw_content,
  };
}
```

- [ ] **Step 3: Build check**

Run: `npm run build`
Expected: clean compile. Anywhere that builds a `Message` literal in tests/helpers (e.g., FakeLlmClient does not, but other helpers might) — fix the missing `rawContent` property by adding `rawContent: null` if needed.

Run grep to find code that constructs `Message` objects:
```bash
grep -rn "conversationId:" src/ tests/ --include="*.ts" | grep -v node_modules
```

For each match that constructs a Message literal in test helpers or fixtures, add `rawContent: null,`.

- [ ] **Step 4: Run all unit tests**

Run: `npx vitest run tests/unit/`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/types.ts src/db/repos/conversations.ts
git commit -m "feat(db): expose raw_content in Message type and conversation loadContext"
```

---

## Task 10: sendCannedReassurance helper

**Files:**
- Create: `src/core/canned-messages.ts`
- Create: `tests/unit/core/canned-messages.spec.ts`

- [ ] **Step 1: Write failing test**

Create `tests/unit/core/canned-messages.spec.ts`:
```typescript
import { describe, it, expect, vi } from 'vitest';
import { sendCannedReassurance } from '../../../src/core/canned-messages.js';
import type { GhlClient } from '../../../src/ghl/client.js';
import type { Salon, Conversation } from '../../../src/core/types.js';

function makeSalon(): Salon {
  return {
    id: 's1',
    displayName: 'Test',
    ghlLocationId: 'loc1',
    ghlPit: 'pit',
    sourceOfTruth: { salon: { owner_first_name: 'Sarah' } } as Salon['sourceOfTruth'],
    config: {} as Salon['config'],
    isActive: true,
  };
}

function makeConversation(): Conversation {
  return {
    id: 'c1',
    salonId: 's1',
    ghlContactId: 'gc1',
    ghlConversationId: null,
    clientHandle: null,
    state: {},
    handoffUntil: null,
    lastMessageAt: null,
  };
}

describe('sendCannedReassurance', () => {
  it('sends message via GHL and persists outbound row', async () => {
    const sendMessage = vi.fn(async () => ({ ghlMessageId: 'm1' }));
    const insertOutbound = vi.fn(async () => undefined);
    const ghl = { sendMessage } as unknown as GhlClient;
    const db = {} as never;

    await sendCannedReassurance(
      { db, ghl, messagesRepo: { insertOutbound } },
      makeSalon(),
      makeConversation(),
      'let me grab Sarah for you',
    );

    expect(sendMessage).toHaveBeenCalledWith({
      contactId: 'gc1',
      type: 'IG',
      message: 'let me grab Sarah for you',
    });
    expect(insertOutbound).toHaveBeenCalledOnce();
    const inserted = insertOutbound.mock.calls[0][1] as {
      textContent: string;
      sanitizeMods: string[] | null;
      ghlMessageId: string;
    };
    expect(inserted.textContent).toBe('let me grab Sarah for you');
    expect(inserted.sanitizeMods).toEqual(['canned_reassurance']);
    expect(inserted.ghlMessageId).toBe('m1');
  });

  it('propagates ghl.sendMessage errors (caller handles)', async () => {
    const sendMessage = vi.fn(async () => {
      throw new Error('outside window');
    });
    const insertOutbound = vi.fn();
    const ghl = { sendMessage } as unknown as GhlClient;
    const db = {} as never;

    await expect(
      sendCannedReassurance(
        { db, ghl, messagesRepo: { insertOutbound } },
        makeSalon(),
        makeConversation(),
        'msg',
      ),
    ).rejects.toThrow('outside window');
    expect(insertOutbound).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

Run: `npx vitest run tests/unit/core/canned-messages.spec.ts`
Expected: `Cannot find module '.../src/core/canned-messages.js'`.

- [ ] **Step 3: Implement sendCannedReassurance**

Create `src/core/canned-messages.ts`:
```typescript
import type { Db } from '../db/kysely.js';
import type { GhlClient } from '../ghl/client.js';
import type { Salon, Conversation } from './types.js';
import * as defaultMessagesRepo from '../db/repos/messages.js';

export interface CannedDeps {
  db: Db;
  ghl: GhlClient;
  messagesRepo?: {
    insertOutbound: typeof defaultMessagesRepo.insertOutbound;
  };
}

export async function sendCannedReassurance(
  deps: CannedDeps,
  _salon: Salon,
  conversation: Conversation,
  message: string,
): Promise<void> {
  const sent = await deps.ghl.sendMessage({
    contactId: conversation.ghlContactId,
    type: 'IG',
    message,
  });
  const repo = deps.messagesRepo ?? defaultMessagesRepo;
  await repo.insertOutbound(deps.db, {
    conversationId: conversation.id,
    textContent: message,
    aiRawOutput: null,
    sanitizeMods: ['canned_reassurance'],
    promptTokens: null,
    completionTokens: null,
    costUsd: null,
    ghlMessageId: sent.ghlMessageId,
  });
}
```

- [ ] **Step 4: Verify `messagesRepo.insertOutbound` signature**

Read `src/db/repos/messages.ts` to confirm `insertOutbound` accepts these fields. If signature differs (e.g., `promptTokens` is required), adjust the call.

If `promptTokens`/`completionTokens` are not optional in the repo function, pass `0` instead of `null`.

- [ ] **Step 5: Run test — expect PASS**

Run: `npx vitest run tests/unit/core/canned-messages.spec.ts`
Expected: 2 tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/core/canned-messages.ts tests/unit/core/canned-messages.spec.ts
git commit -m "feat(core): sendCannedReassurance helper for non-LLM client replies"
```

---

## Task 11: buildPrompt with imagesByMessageId

**Files:**
- Modify: `src/prompt/build.ts`
- Create: `tests/unit/prompt/build.spec.ts` (if not exists; otherwise extend)

- [ ] **Step 1: Check if build.spec.ts exists**

```bash
ls tests/unit/prompt/ 2>/dev/null
```
If `build.spec.ts` exists, extend it. Otherwise create it.

- [ ] **Step 2: Write failing test**

Create or extend `tests/unit/prompt/build.spec.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { buildPrompt } from '../../../src/prompt/build.js';
import type { Salon, ConversationContext } from '../../../src/core/types.js';
import type { ProcessedImage } from '../../../src/images/process.js';

function makeSalon(): Salon {
  return {
    id: 's1',
    displayName: 'Test',
    ghlLocationId: 'loc',
    ghlPit: 'pit',
    sourceOfTruth: {
      salon: {
        name: 'Test Salon',
        owner_first_name: 'Sarah',
        booking_link: 'https://book.test/x',
      },
    } as Salon['sourceOfTruth'],
    config: {
      max_words_per_message: 40,
      max_emojis: 2,
      booking_link_dedup_window: 3,
      response_delay_ms: 40_000,
      handoff_window_hours: 4,
      ghl_custom_field_ids: { needs_owner_attention: 'a', bot_paused_until: 'b', last_escalation_reason: 'c' },
      image_processing: { enabled: true, max_dimension: 1280, jpeg_quality: 80 },
    } as Salon['config'],
    isActive: true,
  };
}

function makeMsg(id: string, direction: 'inbound' | 'outbound', text: string | null): ConversationContext['recentMessages'][number] {
  return {
    id,
    conversationId: 'c1',
    direction,
    channelType: 'text',
    textContent: text,
    aiRawOutput: null,
    sanitizeMods: null,
    ghlMessageId: null,
    createdAt: new Date(),
    rawContent: null,
  };
}

const baseCtx = (msgs: ConversationContext['recentMessages']): ConversationContext => ({
  conversation: {
    id: 'c1',
    salonId: 's1',
    ghlContactId: 'gc1',
    ghlConversationId: null,
    clientHandle: null,
    state: {},
    handoffUntil: null,
    lastMessageAt: null,
  },
  recentMessages: msgs,
  recentEvents: [],
});

const img: ProcessedImage = {
  base64: 'AAAA',
  mediaType: 'image/jpeg',
  width: 800,
  height: 600,
  bytesIn: 1000,
  bytesOut: 500,
};

describe('buildPrompt multimodal output', () => {
  it('returns string content for messages without images', () => {
    const ctx = baseCtx([makeMsg('m1', 'inbound', 'hello')]);
    const result = buildPrompt({ salon: makeSalon(), ctx, bookingLinkRecentlySent: false, imagesByMessageId: new Map() });
    expect(result.messages[0]).toEqual({ role: 'user', content: 'hello' });
  });

  it('returns ContentBlock[] with image+text when inbound has image', () => {
    const ctx = baseCtx([makeMsg('m1', 'inbound', 'look at this')]);
    const imgs = new Map();
    imgs.set('m1', [img]);
    const result = buildPrompt({ salon: makeSalon(), ctx, bookingLinkRecentlySent: false, imagesByMessageId: imgs });
    expect(result.messages[0]).toEqual({
      role: 'user',
      content: [
        { type: 'image', mediaType: 'image/jpeg', base64: 'AAAA' },
        { type: 'text', text: 'look at this' },
      ],
    });
  });

  it('uses placeholder text when inbound has image but no caption', () => {
    const ctx = baseCtx([makeMsg('m1', 'inbound', null)]);
    const imgs = new Map();
    imgs.set('m1', [img]);
    const result = buildPrompt({ salon: makeSalon(), ctx, bookingLinkRecentlySent: false, imagesByMessageId: imgs });
    expect(result.messages[0]).toEqual({
      role: 'user',
      content: [
        { type: 'image', mediaType: 'image/jpeg', base64: 'AAAA' },
        { type: 'text', text: '[image only, no caption]' },
      ],
    });
  });

  it('includes multiple image blocks before text', () => {
    const ctx = baseCtx([makeMsg('m1', 'inbound', 'three views')]);
    const imgs = new Map();
    imgs.set('m1', [img, img, img]);
    const result = buildPrompt({ salon: makeSalon(), ctx, bookingLinkRecentlySent: false, imagesByMessageId: imgs });
    const content = result.messages[0].content as Array<{ type: string }>;
    expect(content).toHaveLength(4);
    expect(content.slice(0, 3).every((b) => b.type === 'image')).toBe(true);
    expect(content[3].type).toBe('text');
  });

  it('only enriches inbound messages, not outbound', () => {
    const ctx = baseCtx([
      makeMsg('m1', 'inbound', 'q'),
      makeMsg('m2', 'outbound', 'a'),
    ]);
    const imgs = new Map();
    imgs.set('m2', [img]);  // attempt to attach image to outbound (should be ignored)
    const result = buildPrompt({ salon: makeSalon(), ctx, bookingLinkRecentlySent: false, imagesByMessageId: imgs });
    expect(result.messages[1]).toEqual({ role: 'assistant', content: 'a' });
  });
});
```

- [ ] **Step 3: Run test — expect FAIL** (current signature doesn't accept imagesByMessageId)

Run: `npx vitest run tests/unit/prompt/build.spec.ts`
Expected: TS errors or test failure because buildPrompt has different signature.

- [ ] **Step 4: Update buildPrompt**

Modify `src/prompt/build.ts`. Update imports at the top:
```typescript
import type { Salon, ConversationContext } from '../core/types.js';
import type { ContentBlock } from '../llm/client.js';
import type { ProcessedImage } from '../images/process.js';
```

Replace the function signature and the message-building loop. The full signature:
```typescript
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
  // ... rest of existing function body unchanged up to the messages array ...
```

Keep the entire `systemPrompt` template literal exactly as today. Replace only the final messages-construction loop:
```typescript
  const messages: BuildPromptOutput['messages'] = [];
  for (const m of ctx.recentMessages) {
    if (m.direction === 'inbound') {
      const imgs = imagesByMessageId.get(m.id);
      if (imgs && imgs.length > 0) {
        const blocks: ContentBlock[] = [];
        for (const img of imgs) {
          blocks.push({ type: 'image', mediaType: img.mediaType, base64: img.base64 });
        }
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

- [ ] **Step 5: Update generateResponse to call buildPrompt with new signature**

This is a transient build break — fixed properly in Task 13. For now, make `generate-response.ts` compile by passing an empty Map:
```typescript
const prompt = buildPrompt({ salon, ctx, bookingLinkRecentlySent, imagesByMessageId: new Map() });
```

- [ ] **Step 6: Run tests — expect PASS**

Run: `npx vitest run tests/unit/prompt/`
Expected: 5 tests pass.

Run: `npm run build`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/prompt/build.ts src/core/generate-response.ts tests/unit/prompt/build.spec.ts
git commit -m "feat(prompt): buildPrompt accepts imagesByMessageId and emits ContentBlock[]"
```

---

## Task 12: handle-inbound — escalation prečaci za video/audio/image_without_url

**Files:**
- Modify: `src/core/handle-inbound.ts`
- Modify: `tests/unit/core/handle-inbound.spec.ts` (if exists; otherwise create)
- Reuse: `src/core/canned-messages.ts` (Task 10) and `src/core/escalate.ts`

- [ ] **Step 1: Check existing inbound tests**

```bash
ls tests/unit/core/ 2>/dev/null
ls tests/e2e/ 2>/dev/null
```
If `handle-inbound.spec.ts` exists, extend it. Otherwise create a new one.

- [ ] **Step 2: Write failing tests**

Create or extend `tests/unit/core/handle-inbound.spec.ts`. Add these test cases (use existing helpers if available; otherwise import from `tests/helpers/`):
```typescript
import { describe, it, expect, vi } from 'vitest';
import { handleInbound } from '../../../src/core/handle-inbound.js';
// ... import test helpers consistent with the project pattern.
// If helpers like createTestDeps or makeSalonRow exist in tests/helpers, use them.

describe('handleInbound attachment classification', () => {
  it('escalates with reason video_attachment when attachment.type=video, no respond job queued', async () => {
    // Setup: salon exists in DB, GHL.getMessage returns { text: '', attachments: [{url, type: 'video'}] }
    // sendMessage stubbed to succeed
    // After:
    //   - escalation_active tag added
    //   - last_escalation_reason custom field set to 'video_attachment'
    //   - canned reassurance message sent (mention owner first name)
    //   - respondQueue.add NOT called
    //   - conversations.handoff_until set in future
    // (Concrete assertions depend on existing test helpers; mirror patterns from tests/e2e/03-escalate-tool.spec.ts)
  });

  it('escalates with reason audio_attachment when attachment.type=audio', async () => {
    // Same as above but type='audio', reason='audio_attachment'
  });

  it('escalates with reason image_without_url when image attachment has no url', async () => {
    // attachments: [{type: 'image', url: null}]
    // reason='image_without_url'
  });

  it('queues respond job when text-only inbound (no attachments)', async () => {
    // text='hi', attachments=[]
    // respondQueue.add called once
    // no escalation
  });

  it('queues respond job when inbound has image with URL (even without caption)', async () => {
    // text='', attachments=[{type:'image', url:'https://x/img.jpg'}]
    // respondQueue.add called once
    // no escalation
  });

  it('drops inbound with no text and no attachments', async () => {
    // text='', attachments=[]
    // respondQueue.add NOT called
    // no escalation
  });

  it('still escalates even if canned reassurance sendMessage throws', async () => {
    // sendMessage throws OutsideMessagingWindowError
    // escalateToOwner still runs
    // log warning emitted
  });
});
```

If the project has no existing handle-inbound spec, follow the pattern in `tests/e2e/03-escalate-tool.spec.ts` to construct deps with `tests/helpers/test-app.ts` and `tests/helpers/test-db.ts`. Use real DB transaction setup (project pattern; not in-memory).

- [ ] **Step 3: Run test — expect FAIL** (logic does not yet differentiate attachments)

Run: `npx vitest run tests/unit/core/handle-inbound.spec.ts`
Expected: tests fail because handle-inbound currently drops on `!textContent`.

- [ ] **Step 4: Modify handle-inbound logic**

Modify `src/core/handle-inbound.ts`. Replace the section after `textContent = fetched.text` through the `setImmediate`/queue add:

```typescript
import { sendCannedReassurance } from './canned-messages.js';
import { escalateToOwner } from './escalate.js';
import * as escalationsRepo from '../db/repos/escalations.js';

// Inside handleInbound, after fetching message:
const fetched = await ghl.getMessage(input.messageId);
const textContent = (input.messageText ?? fetched.text ?? '').trim();
const attachments = fetched.attachments ?? [];

const hasVideo = attachments.some((a) => a.type === 'video');
const hasAudio = attachments.some((a) => a.type === 'audio');
const images = attachments.filter((a) => a.type === 'image' && a.url);
const imagesMissingUrl = attachments.filter((a) => a.type === 'image' && !a.url);

if (!textContent && attachments.length === 0) {
  logger.warn(
    { locationId: input.locationId, contactId: input.contactId },
    'inbound has no text and no attachments; dropping',
  );
  return;
}

const channelType: 'text' | 'image' =
  images.length > 0 || hasVideo || hasAudio || imagesMissingUrl.length > 0 ? 'image' : 'text';

const conversation = await conversationsRepo.findOrCreate(deps.db, salon.id, input.contactId, input.contactHandle);
const inserted = await messagesRepo.insertInbound(deps.db, {
  conversationId: conversation.id,
  channelType,
  rawContent: input.rawPayload,
  textContent: textContent || null,
  ghlMessageId: input.messageId,
});
if (!inserted) {
  logger.info({ messageId: input.messageId }, 'inbound idempotent duplicate; skipping');
  return;
}

logger.info({ conversationId: conversation.id, channelType, attachmentCount: attachments.length }, 'inbound persisted');
await conversationsRepo.touchLastMessageAt(deps.db, conversation.id, new Date());

if (conversation.handoffUntil && conversation.handoffUntil > new Date()) {
  logger.info({ conversationId: conversation.id }, 'handoff active; bot paused');
  return;
}

const owner = salon.sourceOfTruth.salon.owner_first_name;

async function tryCannedAndEscalate(message: string, reason: string): Promise<void> {
  try {
    await sendCannedReassurance({ db: deps.db, ghl }, salon, conversation, message);
  } catch (err) {
    logger.warn({ err, conversationId: conversation.id }, 'canned reassurance failed; proceeding with escalation');
  }
  await escalateToOwner({ db: deps.db, ghl, salon, conversation, reason });
}

if (hasVideo) {
  await tryCannedAndEscalate(
    `haha nije mi se uspio otvoriti video ovdje 🤍 ${owner} ti se javi čim bude između klijenata`,
    'video_attachment',
  );
  return;
}
if (hasAudio) {
  await tryCannedAndEscalate(
    `nisam mogla otvoriti audio poruku 🤍 ${owner} ti se javi čim bude između klijenata`,
    'audio_attachment',
  );
  return;
}
if (imagesMissingUrl.length > 0) {
  await tryCannedAndEscalate(
    `vidim da si poslala nešto, ali mi se ne učitava 🤍 ${owner} ti se javi čim bude između klijenata`,
    'image_without_url',
  );
  return;
}

// Standard put — queue respond job (existing logic, unchanged)
const jobId = `respond-${conversation.id}`;
const delay = deps.responseDelayMsOverride ?? salon.config.response_delay_ms;
await deps.respondQueue.remove(jobId).catch(() => undefined);
await deps.respondQueue.add(
  'respond',
  { conversationId: conversation.id, salonId: salon.id },
  { jobId, delay, removeOnComplete: true, removeOnFail: 10 },
);
logger.info({ conversationId: conversation.id, jobId, delayMs: delay }, 'respond job queued');
```

- [ ] **Step 5: Run test — expect PASS**

Run: `npx vitest run tests/unit/core/handle-inbound.spec.ts`
Expected: 7 tests pass.

- [ ] **Step 6: Run full unit suite to catch regressions**

Run: `npx vitest run tests/unit/`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/core/handle-inbound.ts tests/unit/core/handle-inbound.spec.ts
git commit -m "feat(inbound): hard-escalate video/audio/image-without-url with canned reassurance"
```

---

## Task 13: generate-response — image fetch orchestration

**Files:**
- Modify: `src/core/generate-response.ts`
- Create: `tests/unit/core/generate-response-images.spec.ts`

- [ ] **Step 1: Write failing test**

Create `tests/unit/core/generate-response-images.spec.ts`:
```typescript
import { describe, it, expect, vi } from 'vitest';
import { generateResponse } from '../../../src/core/generate-response.js';
// Use existing test helpers (test-db, test-app) and stub Ghl + LLM clients.
// Build a conversation with one inbound message that has an image attachment in raw_content.
// Stub fetchAttachment via dependency injection or by mocking the http layer.

describe('generateResponse image orchestration', () => {
  it('passes image content block to LLM when current inbound has image and fetch succeeds', async () => {
    // Setup: salon with image_processing.enabled=true
    //        conversation with one inbound message containing raw_content: { attachments: [{url: '...', type: 'image'}] }
    //        fetcher stub returns small JPEG buffer
    // Run generateResponse
    // Assert: fakeLlm.calls[0].messages[0].content is ContentBlock[] with one image block
  });

  it('escalates with attachment_fetch_failed when current-turn image fetch fails', async () => {
    // fetcher stub throws AttachmentFetchError for current-turn URL
    // Run generateResponse
    // Assert: escalation row created with reason 'attachment_fetch_failed'
    //         no LLM call made
  });

  it('logs and skips historical image failure without escalating', async () => {
    // Two inbound messages: m1 has image (older), m2 is text-only (current)
    // fetcher returns 404 for m1's URL
    // Run generateResponse
    // Assert: no escalation, LLM called with messages[0].content = string (m1 image skipped)
  });

  it('skips LLM entirely and escalates when salon.config.image_processing.enabled is false and inbound has image', async () => {
    // image_processing.enabled = false
    // Inbound has image attachment
    // Assert: escalation reason 'image_processing_disabled'
    //         no fetch call, no LLM call
  });

  it('passes string content when no inbound message has images', async () => {
    // Conversation has only text messages
    // Assert: fakeLlm.calls[0].messages all have content as string (backward-compat path)
  });
});
```

Use `tests/helpers/fake-llm-client.ts` for the LLM mock. For `fetchAttachment` mocking, inject a custom fetcher via deps (next step adds the injection point).

- [ ] **Step 2: Add fetcher injection point to generate-response**

`generateResponse` needs to accept an injected fetcher for testability. Modify `GenerateResponseDeps`:
```typescript
import type { fetchAttachment as FetchAttachmentFn } from '../images/fetch.js';

export interface GenerateResponseDeps {
  db: Db;
  ghl: GhlClient;
  llm: LlmClient;
  defaultLlmModel: string;
  fetchAttachment?: typeof FetchAttachmentFn;  // testability hook; defaults to real impl
}
```

- [ ] **Step 3: Implement image orchestration in generateResponse**

Modify `src/core/generate-response.ts`. After loading `ctx` but before `buildPrompt`:

```typescript
import { extractImageAttachments } from '../images/extract-attachments.js';
import { fetchAttachment as defaultFetchAttachment } from '../images/fetch.js';
import { processImageForVision, type ProcessedImage } from '../images/process.js';

// ... inside generateResponse function, after ctx is loaded ...

const imagesByMessageId = new Map<string, ProcessedImage[]>();
const lastInbound = [...ctx.recentMessages].reverse().find((m) => m.direction === 'inbound');
const lastInboundAttachments = lastInbound ? extractImageAttachments(lastInbound.rawContent) : [];

if (!salon.config.image_processing.enabled && lastInboundAttachments.length > 0) {
  logger.info({ conversationId, salonId: salon.id }, 'image_processing disabled; escalating');
  await escalateToOwner({
    db: deps.db,
    ghl: deps.ghl,
    salon,
    conversation: ctx.conversation,
    reason: 'image_processing_disabled',
  });
  return;
}

if (salon.config.image_processing.enabled) {
  const fetchFn = deps.fetchAttachment ?? defaultFetchAttachment;

  for (const msg of ctx.recentMessages) {
    if (msg.direction !== 'inbound') continue;
    const rawAttachments = extractImageAttachments(msg.rawContent);
    if (rawAttachments.length === 0) continue;

    const settled = await Promise.allSettled(
      rawAttachments.map(async (att) => {
        const buf = await fetchFn(att.url, salon.ghlPit);
        return processImageForVision(buf);
      }),
    );

    const succeeded: ProcessedImage[] = [];
    for (const r of settled) {
      if (r.status === 'fulfilled') {
        succeeded.push(r.value);
      } else {
        logger.warn({ err: r.reason, messageId: msg.id }, 'image fetch/process failed; skipping');
      }
    }
    if (succeeded.length > 0) imagesByMessageId.set(msg.id, succeeded);
  }

  // Current-turn failure check
  if (lastInbound && lastInboundAttachments.length > 0) {
    const processedForLast = imagesByMessageId.get(lastInbound.id);
    if (!processedForLast || processedForLast.length === 0) {
      logger.warn({ conversationId, messageId: lastInbound.id }, 'current-turn image fetch failed; escalating');
      await escalateToOwner({
        db: deps.db,
        ghl: deps.ghl,
        salon,
        conversation: ctx.conversation,
        reason: 'attachment_fetch_failed',
      });
      return;
    }
  }
}

// Update buildPrompt call — was: buildPrompt(salon, ctx, bookingLinkRecentlySent)
const prompt = buildPrompt({ salon, ctx, bookingLinkRecentlySent, imagesByMessageId });
```

- [ ] **Step 4: Run test — expect PASS**

Run: `npx vitest run tests/unit/core/generate-response-images.spec.ts`
Expected: 5 tests pass.

- [ ] **Step 5: Run full suite (unit + existing e2e)**

Run: `npx vitest run`
Expected: all green. Existing e2e tests (01-04) should still pass — they don't involve images, so the orchestration loop is a no-op.

- [ ] **Step 6: Commit**

```bash
git add src/core/generate-response.ts tests/unit/core/generate-response-images.spec.ts
git commit -m "feat(core): fetch+process images for last 15 inbound messages before LLM call"
```

---

## Task 14: E2E integration test — full image handling path

**Files:**
- Create: `tests/e2e/06-image-handling.spec.ts`

- [ ] **Step 1: Write end-to-end test**

Create `tests/e2e/06-image-handling.spec.ts` following the pattern of existing e2e tests (`tests/e2e/01-simple-qa.spec.ts`, etc.):
```typescript
import { describe, it, expect } from 'vitest';
import { createTestApp } from '../helpers/test-app.js';
// Use the project's e2e patterns: spin up app with test DB + mock GHL + FakeLlmClient,
// POST a webhook payload, wait for processing, assert outbound message and DB state.

describe('e2e image handling', () => {
  it('inbound with image attachment results in vision LLM call and outbound reply', async () => {
    const { app, fakeLlm, mockGhl, cleanup } = await createTestApp();
    try {
      // Stage GHL.getMessage to return text + image attachment
      mockGhl.stageGetMessage('msg-1', {
        text: 'check this',
        attachments: [{ url: 'https://x.test/img.jpg', type: 'image' }],
      });

      // Stage fetchAttachment behavior — depends on how app wires deps in tests.
      // Most pragmatic: inject a fetcher that returns a small valid JPEG buffer.

      // Stage LLM response
      fakeLlm.stage({
        match: (input) => {
          const last = input.messages.at(-1);
          if (!last) return false;
          return Array.isArray(last.content) && last.content.some((b: { type: string }) => b.type === 'image');
        },
        output: {
          text: 'love that 🤍 grab a consultation here https://book.test/x',
        },
      });

      // Fire inbound webhook
      const response = await app.inject({
        method: 'POST',
        url: '/webhooks/ghl/inbound',
        headers: { 'x-webhook-secret': 'test-secret' },
        payload: {
          location_id: 'test-loc',
          contact_id: 'test-contact',
          message_id: 'msg-1',
          message_text: 'check this',
        },
      });
      expect(response.statusCode).toBe(200);

      // Wait for processing (use existing helper if available; otherwise poll DB)
      await new Promise((r) => setTimeout(r, 200));

      // Assert outbound message exists with booking link
      // (assertion shape depends on existing helpers; mirror existing e2e tests)
      expect(fakeLlm.calls).toHaveLength(1);
      const llmCall = fakeLlm.calls[0];
      const userMsg = llmCall.messages.at(-1);
      expect(Array.isArray(userMsg?.content)).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('inbound with video attachment escalates without LLM call', async () => {
    const { app, fakeLlm, mockGhl, cleanup } = await createTestApp();
    try {
      mockGhl.stageGetMessage('msg-2', {
        text: '',
        attachments: [{ url: 'https://x.test/v.mp4', type: 'video' }],
      });

      const response = await app.inject({
        method: 'POST',
        url: '/webhooks/ghl/inbound',
        headers: { 'x-webhook-secret': 'test-secret' },
        payload: {
          location_id: 'test-loc',
          contact_id: 'test-contact-2',
          message_id: 'msg-2',
        },
      });
      expect(response.statusCode).toBe(200);
      await new Promise((r) => setTimeout(r, 200));

      // Assert: no LLM call, escalation tag applied, canned reassurance sent
      expect(fakeLlm.calls).toHaveLength(0);
      // Additional assertions per existing e2e helpers
    } finally {
      await cleanup();
    }
  });
});
```

If `createTestApp` / `mockGhl.stageGetMessage` patterns don't match the existing helpers exactly, adapt to match `tests/helpers/test-app.ts` and `tests/e2e/03-escalate-tool.spec.ts` conventions. Do NOT invent new helpers — use what exists.

If the existing test app does NOT support image fetcher injection at the app level, add a thin override on `app.deps.fetchAttachment` set during app construction (mirror how llm/ghl are injected).

- [ ] **Step 2: Run e2e test — expect PASS after any helper wiring adjustments**

Run: `npx vitest run tests/e2e/06-image-handling.spec.ts`
Expected: 2 tests pass.

- [ ] **Step 3: Run full suite**

Run: `npx vitest run`
Expected: all green (all unit + all 5 existing e2e + new 06-e2e).

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/06-image-handling.spec.ts tests/helpers/  # only if helpers required edits
git commit -m "test(e2e): cover image handling end-to-end (inbound → vision LLM → outbound)"
```

---

## Final verification

- [ ] **Step 1: Full test suite**

Run: `npx vitest run`
Expected: 100% green across unit + e2e.

- [ ] **Step 2: Build + lint**

Run: `npm run build`
Expected: clean.

- [ ] **Step 3: Migration safety check (no DB migration ran)**

```bash
ls src/db/migrations/
```
Expected: only `0001_initial.ts` (no new migration added — by design, since `messages.channel_type` and `raw_content` already exist).

- [ ] **Step 4: Disable feature in DB for all existing salons before deploy**

Before merging/deploying to production, run this SQL against the production database:
```sql
UPDATE salons SET config = config || '{"image_processing":{"enabled":false}}'::jsonb;
```

This ensures rollout is opt-in per salon. Re-enable on the pilot salon manually:
```sql
UPDATE salons SET config = jsonb_set(config, '{image_processing,enabled}', 'true'::jsonb)
WHERE id = '<pilot-salon-id>';
```

Document the pilot salon ID in the deploy runbook.

---

## Out of scope (intentional, see spec)

- Voice memo transcription (audio = escalate)
- Video frame extraction (video = escalate)
- HEIC / SVG support (always escalate)
- Per-message image count limit (rely on compression + auto-cache)
- Object storage for retroactive audit
- Vision model capability auto-detection
- Per-salon vision prompt override
- One-time view special path (defensive `image_without_url` escalation covers it)
- Image dedup by URL

## Self-Review (run inline before handing off)

**Spec coverage check** — every spec section maps to a task:
- Sekcija 1 (data flow): Tasks 12, 13 (inbound + worker orchestration)
- Sekcija 2.1 (LlmClient interface): Task 5
- Sekcija 2.2 (provider mappers): Tasks 6, 7, 8
- Sekcija 2.3 (fetchAttachment): Task 3
- Sekcija 2.4 (processImageForVision): Task 2
- Sekcija 2.5 (inbound handler + canned helper): Tasks 10, 12
- Sekcija 2.6 (generate-response orchestration): Task 13
- Sekcija 2.7 (buildPrompt): Task 11
- Sekcija 2.8 (salon config): Task 1
- Sekcija 2.9 (rawContent in mapper): Task 9
- Sekcija 2.10 (sharp dep): Task 1
- Sekcija 5 (testing): every task includes unit tests; Task 14 covers e2e
- Sekcija 7 (rollout): Final verification step 4

**Type consistency check:**
- `ProcessedImage` defined in Task 2, used in Tasks 11, 13 — same shape ✓
- `ContentBlock` defined in Task 5, used in Tasks 6, 7, 8, 11 — same shape ✓
- `ExtractedImageAttachment` defined in Task 4, used in Task 13 — same shape ✓
- `fetchAttachment` signature `(url, pit, fetcher?)` — Task 3 defines, Task 13 calls with `(url, salon.ghlPit)` ✓
