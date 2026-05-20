# Instagram Image Handling V1 Design

**Status**: Approved (brainstorming output)
**Date**: 2026-05-20
**Owner**: Ivan
**Predecessor**: [`2026-05-15-render-deploy-design.md`](./2026-05-15-render-deploy-design.md)
**Scope**: Dodavanje multimodalnog (vision) handlinga za slike koje klijenti šalju kroz Instagram DM-ove. V1 obuhvaća: vision odgovor na slike kroz LLM, eskalaciju na vlasnika za video/audio attachmente, defensivni handling za one-time view i druge edge case-ove. Voice memo transkripcija, video frame extraction, HEIC i SVG podrška su eksplicitno van scope-a.

---

## 0. Context

Trenutno stanje: GHL webhook stiže s `attachments` u payload-u, GHL klijentov `getMessage` ih izlaže kao `Array<{url, type: 'image' | 'audio' | 'video'}>`, ali `handle-inbound` bezuvjetno odbacuje svaku poruku bez `textContent`. Bot nikad ne vidi slike. Postojeći system prompt već ima napisanu "IMAGE HANDLING" sekciju s naputkom o opservacijskom opisu + consultation framing-u, ali u runtime tijeku nema vizije pa su te upute aspiracijske.

V1 razbija to ograničenje za **slike**. Video i audio ostaju eskalacijski signal — vizijski modeli ih ne primaju direktno, frame extraction i transkripcija su dodatna kompleksnost koja ne pripada ovom feature-u.

### 0.1 Decisions table

| Decision | Value |
|---|---|
| Vision strategy | Backend fetcha sliku → kompresira → base64 → ubacuje u LLM content blocks. URL nikad ne ide do LLM-a. |
| Image memory | Sve inbound slike u zadnjih 15 poruka ulaze u svaki LLM poziv (oslanjamo se na OpenAI auto-cache za 50% popust; Anthropic 90% kad se prebacimo). |
| Compression target | 1280px na dužoj strani, JPEG q80, mozjpeg encoder. Uvijek konvertira u JPEG bez obzira na input format. |
| Allowed input formats | image/jpeg, image/png, image/gif, image/webp. HEIC, SVG, AI eksplicitno isključeni → escalate. |
| Video handling | Bez procesiranja. Hard escalate s reason `video_attachment`, bez LLM poziva. |
| Audio handling | Bez procesiranja. Hard escalate s reason `audio_attachment`, bez LLM poziva. |
| Multi-attachment | Sve slike iz iste poruke u jednom LLM pozivu kao odvojeni image content blocks. |
| URL fetch strategy | Defensivno: probaj bez auth-a, na 401/403 retry sa GHL PIT Bearer header. Na fail eskaliraj s `attachment_fetch_failed`. |
| Storage | Samo URL u postojećem `messages.raw_content` JSONB. Nema novog object storage. URL ekspiracija prihvaćena. |
| Image count limit | Bez count limita u v1. Obrana je kompresija + auto-cache. |
| Provider scope | LlmClient interface postaje multimodalan; Anthropic, OpenAI, Gemini implementacije sve dobivaju content blocks mapping. |
| Kill switch | `salon.config.image_processing.enabled` per-salon. Default `true` u shemi, ali se postavlja `false` za postojeće salone u bazi prije deploy-a. |
| Migration | Nema DB migracije. `messages.channel_type` enum već uključuje `'image'`, `raw_content` već sprema GHL payload. |

---

## 1. High-level data flow

```
Instagram DM (text + attachments)
        │
        ▼
GHL webhook → POST /webhooks/ghl/inbound
        │
        ▼
handle-inbound:
  - getMessage(messageId) → { text, attachments: [{url, type}] }
  - Persistira poruku u DB s channel_type='image' ako attachments postoje,
    sve attachmente u raw_content JSONB
  ┌─────────────────────────────────────────────────────────────┐
  │ Klasifikacija prije respond job-a:                          │
  │   hasVideo  → escalate 'video_attachment',  NO LLM call     │
  │   hasAudio  → escalate 'audio_attachment',  NO LLM call     │
  │   image bez URL-a → escalate 'image_without_url', NO LLM    │
  │   inače: queue respond job (standard put)                   │
  └─────────────────────────────────────────────────────────────┘
        │
        ▼
respond worker (generateResponse):
  - loadContext (zadnjih 15 poruka, sve s raw_content)
  - Image orchestration prije buildPrompt-a:
      za svaku inbound poruku u history-u koja ima image attachment:
        fetch(url) → sharp() resize+compress → base64
        spremaj u imagesByMessageId map
  - Failure na CURRENT turn slike → escalate 'attachment_fetch_failed'
  - Failure na HISTORICAL slike → log + skip, NE escalate
  - LlmClient.complete s multimodal content blocks
  - LLM vraća tekst → sanitizer → GHL sendMessage (postojeći put)
```

Ključne odluke:

- **Slike iz povijesti ulaze u svaki LLM poziv.** Klijent može referencirati sliku poslanu 5 poruka ranije ("a koja je boja na ovoj prvoj slici") i bot će razumjeti.
- **Video/audio = hard escalate prečac.** Bez LLM poziva, 0 vision tokena za poruke gdje LLM ne pomaže.
- **Slika fetch I/O je u workeru, ne u buildPrompt-u.** buildPrompt ostaje sinhrona pure funkcija — testabilna bez I/O moka.

---

## 2. Component changes

### 2.1 LlmClient interface (`src/llm/client.ts`)

Trenutni interface:
```typescript
interface LlmCompleteInput {
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  // ...
}
```

Novi interface (provider-agnostic):
```typescript
type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: 'image/jpeg' | 'image/png' | 'image/webp'; base64: string };

interface LlmCompleteInput {
  messages: Array<{
    role: 'user' | 'assistant';
    content: string | ContentBlock[];
  }>;
  // ...
}
```

`content: string` ostaje za backward compat — postojeći text-only flow ne mijenja semantiku, provideri interno wrappaju string u jedan text block.

### 2.2 Provider mappers

**`src/llm/anthropic.ts`** — content blocks postaju Anthropic content array:
```typescript
{ role: 'user', content: [
  { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: '...' } },
  { type: 'text', text: '...' }
]}
```

**`src/llm/openai.ts`** — content blocks postaju OpenAI multipart content:
```typescript
{ role: 'user', content: [
  { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,...' } },
  { type: 'text', text: '...' }
]}
```

**`src/llm/gemini.ts`** — content blocks postaju Gemini `parts` array:
```typescript
{ role: 'user', parts: [
  { inline_data: { mime_type: 'image/jpeg', data: '...' } },
  { text: '...' }
]}
```

### 2.3 Image fetch (`src/images/fetch.ts`)

```typescript
const MAX_INPUT_BYTES = 5 * 1024 * 1024;  // GHL hard cap
const FETCH_TIMEOUT_MS = 10_000;

export async function fetchAttachment(url: string, pit: string): Promise<Buffer> {
  // Try 1: plain fetch (radi za pre-signed i public CDN URL-ove)
  let res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });

  // Try 2: s GHL PIT auth header-om (radi ako GHL traži auth)
  if (!res.ok && (res.status === 401 || res.status === 403)) {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${pit}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  }

  if (!res.ok) throw new AttachmentFetchError(res.status, url);

  const contentLength = parseInt(res.headers.get('content-length') ?? '0', 10);
  if (contentLength > MAX_INPUT_BYTES) {
    throw new ImageTooLargeError(contentLength);
  }

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_INPUT_BYTES) throw new ImageTooLargeError(buf.length);
  return buf;
}
```

### 2.4 Image processing (`src/images/process.ts`)

```typescript
import sharp from 'sharp';

const MAX_DIMENSION = 1280;
const JPEG_QUALITY = 80;
const ALLOWED_INPUT_FORMATS = ['jpeg', 'jpg', 'png', 'gif', 'webp'];

export async function processImageForVision(input: Buffer): Promise<ProcessedImage> {
  const meta = await sharp(input).metadata();
  if (!meta.format || !ALLOWED_INPUT_FORMATS.includes(meta.format)) {
    throw new UnsupportedImageFormatError(meta.format ?? 'unknown');
  }

  const pipeline = sharp(input)
    .rotate()  // primjenjuje EXIF orijentaciju
    .resize({
      width: MAX_DIMENSION,
      height: MAX_DIMENSION,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality: JPEG_QUALITY, mozjpeg: true });

  const out = await pipeline.toBuffer({ resolveWithObject: true });

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

Razlozi za odabir parametara:
- **1280px** je sigurna donja granica (Anthropic preporuča ≤1568px, OpenAI ≤2048px). Štedi vision tokene, hvata sve relevantne detalje kose.
- **JPEG q80 + mozjpeg** — vizualno blizu loseless, 30-50% manji od defaultnog JPEG encodera.
- **Output uvijek JPEG** — uniformnost, manja media_type matrica.
- **Animirani GIF** → samo prvi frame ekstrahiran (sharp default). 99% IG GIF-ova su reakcijski, prvi frame je dovoljan.

### 2.5 Inbound handler (`src/core/handle-inbound.ts`)

Trenutno bezuvjetno dropa poruke bez `textContent`. Mijenja se na granularnu klasifikaciju:

```typescript
const fetched = await ghl.getMessage(input.messageId);
const text = fetched.text;
const attachments = fetched.attachments;

const hasVideo = attachments.some((a) => a.type === 'video');
const hasAudio = attachments.some((a) => a.type === 'audio');
const images = attachments.filter((a) => a.type === 'image' && a.url);
const imagesMissingUrl = attachments.filter((a) => a.type === 'image' && !a.url);

if (!text && attachments.length === 0) {
  logger.warn('inbound has no text and no attachments; dropping');
  return;
}

// Persist (uključujući attachmente u raw_content)
const channelType: 'text' | 'image' =
  (images.length > 0 || hasVideo || hasAudio || imagesMissingUrl.length > 0) ? 'image' : 'text';
const inserted = await messagesRepo.insertInbound(db, { ..., channelType, textContent: text || null });

// Hard escalation prečaci — preskoči respond queue
// sendCannedReassurance failure (npr. izvan 24h IG window-a) MORA biti defensive —
// escalateToOwner se uvijek izvršava, čak ako klijent ne dobije text.
async function tryCannedAndEscalate(message: string, reason: string): Promise<void> {
  try {
    await sendCannedReassurance(deps, salon, conversation, message);
  } catch (err) {
    logger.warn({ err, conversationId: conversation.id }, 'canned reassurance failed; proceeding with escalation');
  }
  await escalateToOwner({ ..., reason });
}

if (hasVideo) {
  await tryCannedAndEscalate(
    `haha nije mi se uspio otvoriti video ovdje 🤍 ${owner} ti se javi čim bude između klijenata`,
    'video_attachment'
  );
  return;
}
if (hasAudio) {
  await tryCannedAndEscalate(
    `nisam mogla otvoriti audio poruku 🤍 ${owner} ti se javi čim bude između klijenata`,
    'audio_attachment'
  );
  return;
}
if (imagesMissingUrl.length > 0) {
  await tryCannedAndEscalate(
    `vidim da si poslala nešto, ali mi se ne učitava 🤍 ${owner} ti se javi čim bude između klijenata`,
    'image_without_url'
  );
  return;
}

// Standard put — queue respond job (postojeća logika)
```

**Novi helper `sendCannedReassurance`** živi u `src/core/canned-messages.ts` i rješava postojeću rupu u `escalateToOwner`: ako bot eskalira bez prethodnog LLM teksta, klijent vidi tišinu. Canned poruka ide kroz `ghl.sendMessage` prije nego `escalateToOwner` postavi `handoff_until` flag. Signatura:

```typescript
export async function sendCannedReassurance(
  deps: { db: Db; ghl: GhlClient },
  salon: Salon,
  conversation: Conversation,
  message: string,
): Promise<void>;
```

Helper interpolira `${owner}` iz `salon.sourceOfTruth.salon.owner_first_name` prije slanja, persistira outbound poruku u `messages` tablicu (s `direction: 'outbound'`, `aiRawOutput: null`, `sanitizeMods: ['canned_reassurance']` za auditabilnost).

### 2.6 Generate response orchestration (`src/core/generate-response.ts`)

Prije postojećeg `buildPrompt + llm.complete` flow-a dodaje se image fetch loop:

```typescript
const ctx = await conversationsRepo.loadContext(db, conversationId, 15);
const imagesByMessageId = new Map<string, ProcessedImage[]>();

for (const msg of ctx.recentMessages) {
  if (msg.direction !== 'inbound') continue;
  const rawAttachments = extractImageAttachments(msg.rawContent);
  if (rawAttachments.length === 0) continue;

  // Paralelni fetch za istu poruku, serijski među porukama
  const processed = await Promise.allSettled(
    rawAttachments.map(async (att) => {
      const buf = await fetchAttachment(att.url, salon.ghlPit);
      return processImageForVision(buf);
    })
  );

  const succeeded = processed
    .filter((r): r is PromiseFulfilledResult<ProcessedImage> => r.status === 'fulfilled')
    .map((r) => r.value);

  if (succeeded.length > 0) imagesByMessageId.set(msg.id, succeeded);
}

// Current-turn failure check
const lastInbound = ctx.recentMessages.findLast((m) => m.direction === 'inbound');
const lastInboundHadAttachments = lastInbound && extractImageAttachments(lastInbound.rawContent).length > 0;
const lastInboundProcessed = lastInbound && imagesByMessageId.get(lastInbound.id);
if (lastInboundHadAttachments && (!lastInboundProcessed || lastInboundProcessed.length === 0)) {
  await escalateToOwner({ ..., reason: 'attachment_fetch_failed' });
  return;
}

// Postojeći put
const prompt = buildPrompt({ salon, ctx, bookingLinkRecentlySent, imagesByMessageId });
// ... ostatak istog flow-a ...
```

### 2.7 buildPrompt (`src/prompt/build.ts`)

Signatura se mijenja:
```typescript
interface BuildPromptInput {
  salon: Salon;
  ctx: ConversationContext;
  bookingLinkRecentlySent: boolean;
  imagesByMessageId: Map<string, ProcessedImage[]>;  // novo
}
```

Mapping inbound poruka u user turn-ove postaje conditional:
```typescript
for (const m of ctx.recentMessages) {
  const role = m.direction === 'inbound' ? 'user' : 'assistant';

  if (role === 'user' && imagesByMessageId.has(m.id)) {
    const blocks: ContentBlock[] = [];
    for (const img of imagesByMessageId.get(m.id)!) {
      blocks.push({ type: 'image', mediaType: img.mediaType, base64: img.base64 });
    }
    blocks.push({ type: 'text', text: m.textContent ?? '[image only, no caption]' });
    messages.push({ role: 'user', content: blocks });
  } else {
    messages.push({ role, content: m.textContent ?? '' });
  }
}
```

`'[image only, no caption]'` placeholder kad caption-a nema — vision modeli daju bolji output kad svaki user turn ima i tekstualni element.

### 2.8 Salon config (`src/core/salon-config-schema.ts`)

Novo polje u Zod shemi:
```typescript
image_processing: z.object({
  enabled: z.boolean().default(true),
  max_dimension: z.number().int().min(512).max(2048).default(1280),
  jpeg_quality: z.number().int().min(40).max(95).default(80),
}).default({}),
```

`enabled: false` po salonu znači: svaka slika eskalira umjesto da ide u LLM. Kill switch za rollout.

### 2.9 Conversation context (`src/db/repos/conversations.ts`)

`loadContext` već vraća `Message` objekte, ali `rawContent` polje treba biti eksponirano u mapperu. Trenutni `rowToMessage` ga NE vraća — treba dodati:

```typescript
function rowToMessage(row): Message {
  return {
    // ... postojeća polja ...
    rawContent: row.raw_content,  // novo
  };
}
```

Bez ovoga `extractImageAttachments` ne može doći do attachmenta iz history poruka.

### 2.10 Nove dependencies

```json
{ "dependencies": { "sharp": "^0.33.0" } }
```

Sharp dolazi s vlastitom kopijom libvips, prebuilt binaries za linux-x64 (Render) i win32-x64 (Windows dev). Nema sistemskih dependency-ja.

---

## 3. File layout

```
src/
├── images/                       # NEW
│   ├── fetch.ts                  # fetchAttachment(url, pit)
│   ├── process.ts                # processImageForVision(buffer)
│   ├── errors.ts                 # AttachmentFetchError, UnsupportedImageFormatError, ImageTooLargeError
│   └── extract-attachments.ts    # extractImageAttachments(rawContent) helper
├── llm/
│   ├── client.ts                 # MODIFIED — ContentBlock type, multimodal content u messages
│   ├── anthropic.ts              # MODIFIED — content blocks → Anthropic format
│   ├── openai.ts                 # MODIFIED — content blocks → OpenAI format
│   └── gemini.ts                 # MODIFIED — content blocks → Gemini format
├── core/
│   ├── handle-inbound.ts         # MODIFIED — escalation prečaci za video/audio/missing URL
│   ├── generate-response.ts      # MODIFIED — image fetch orchestration prije buildPrompt
│   ├── salon-config-schema.ts    # MODIFIED — image_processing sub-schema
│   └── canned-messages.ts        # NEW — sendCannedReassurance helper
├── prompt/
│   └── build.ts                  # MODIFIED — imagesByMessageId argument, ContentBlock[] output
└── db/repos/
    └── conversations.ts          # MODIFIED — rowToMessage izlaže rawContent

test/
└── fixtures/images/              # NEW
    ├── landscape-2000x1500.jpg
    ├── small-800x600.jpg
    ├── portrait-with-exif.jpg
    ├── simple.png
    ├── animated.gif
    └── not-an-image.bin
```

Sanitizer, escalation logika, queue, GHL klijent — netaknuti.

---

## 4. Error handling i edge cases

### 4.1 Failure modes (current turn)

| Failure | Reason eskalacije | Klijent vidi |
|---|---|---|
| Video attachment | `video_attachment` | Canned reassurance prije escalation flaga |
| Audio attachment | `audio_attachment` | Canned reassurance |
| Image bez URL-a | `image_without_url` | Canned reassurance |
| Image fetch 401/403 nakon retry-a | `attachment_fetch_failed` | Canned reassurance |
| Image fetch 404 / timeout | `attachment_fetch_failed` | Canned reassurance |
| Image > 5MB | `attachment_fetch_failed` | Canned reassurance |
| HEIC / SVG / nepoznat format | `attachment_fetch_failed` | Canned reassurance |
| LLM vision call fail (3x retry) | `llm_failed` (postojeća logika) | Tišina (postojeća rupa, ne fiksamo u v1) |

### 4.2 Failure modes (history)

Slike koje ne uspije fetchati iz history-a (URL ekspirirao i sl.) — **NE eskaliraju.** Log na warn nivou, sliku se preskače, bot odgovara s onim što vidi. Razlog: URL ekspiracija je očekivani failure mod za stare slike, ne želimo eskalirati cijeli razgovor jer je nešto staro nedostupno.

### 4.3 Edge cases pokriveni postojećim kodom

- **Slika + escalate_to_owner tool call** — postojeća "send text first, then escalate" logika radi nepromijenjeno.
- **Slika + mark_link_sent** — sanitizer radi na text outputu, ne na input slikama.
- **Slika tijekom aktivnog handoff-a** — handle-inbound ne queue-a respond job kad je `handoff_until` u budućnosti; attachment se persistira u `raw_content`, vlasnik vidi u GHL UI.
- **5 slika u rapid succession** — rolling-delay coalescing već postoji; worker fire-a jednom, učita history s 15 poruka, fetcha sve slike paralelno-unutar-poruke i serijski-među-porukama, LLM dobije sve.

### 4.4 LLM model bez vision podrške

Ne provjeravamo capability u v1. Ako salon koristi non-vision model i stigne slika, vision content blocks idu u API → API vrati error → postojeći 3x retry loop u `generateResponse` → escalate s `reason: 'llm_failed'`. Vlasnik intervenira ručno.

Kasnije može se dodati `vision_capable: boolean` per model u factory ako se ovo pokaže kao stvarni problem.

---

## 5. Testing strategy

### 5.1 Unit testovi (vitest)

**`src/images/process.test.ts`** — sharp processing s realnim fixtures:
- Landscape 2000×1500 JPEG → resize na 1280×960
- Mali 800×600 JPEG → ostaje 800×600 (`withoutEnlargement`)
- PNG → output media_type je `image/jpeg`
- Portrait s EXIF orijentacijom → output je rotiran
- Animirani GIF → izvuče prvi frame, output JPEG
- HEIC fixture → `UnsupportedImageFormatError`
- SVG fixture → `UnsupportedImageFormatError`
- Random bytes → `UnsupportedImageFormatError`

**`src/images/fetch.test.ts`** — mock fetch:
- Plain fetch (200) → vraća buffer
- Plain fetch (401) → retry s Bearer (200) → vraća buffer
- Plain fetch (401) → retry s Bearer (403) → throws `AttachmentFetchError`
- Plain fetch (404) → no retry → throws `AttachmentFetchError`
- Network timeout → throws `AttachmentFetchError`
- Content-Length > 5MB → throws `ImageTooLargeError`

**`src/llm/anthropic.test.ts`, `openai.test.ts`, `gemini.test.ts`** — provider mapping:
- String content → ostaje string (backward compat)
- ContentBlock[] s text → ekvivalent string verziji
- ContentBlock[] s image + text → ispravan format po provideru
- ContentBlock[] s 2 images + text → svi blocks present u tom redoslijedu

**`src/prompt/build.test.ts`** — extend postojeći test:
- Inbound bez slika → `content` string (kao i danas)
- Inbound sa slikom → `content` je ContentBlock[]
- Inbound samo slika bez caption → placeholder `'[image only, no caption]'`
- Inbound s 3 slike → 3 image blocka + 1 text block
- 2 inbound poruke u history-u sa slikama → obje dobiju image blocks

### 5.2 Integration testovi

**`src/core/handle-inbound.test.ts`** — extend:
- Inbound s video attachment → escalate s `video_attachment`, NO respond job, canned reassurance poslana
- Inbound s audio attachment → escalate `audio_attachment`
- Inbound s image bez URL-a → escalate `image_without_url`
- Inbound s tekstom + 2 slike → queue respond job
- Inbound bez teksta + 1 slika → queue respond job (NE drop)
- Inbound bez teksta i bez attachmenta → drop

**`src/core/generate-response.test.ts`** — extend:
- Slika u zadnjoj inbound poruci uspješno procesirana → LLM dobije image content block
- Slika u zadnjoj inbound poruci, fetch fail → escalate `attachment_fetch_failed`
- Slika u prethodnoj inbound poruci (history), fetch fail → log + skip, NE escalate
- Salon ima `image_processing.enabled: false` → svaka slika escalate, nema LLM poziva

### 5.3 Što NE testiramo

- Stvarni GHL HTTP poziv (sve mock)
- Stvarni LLM poziv (mock response)
- View-once Instagram payload (nemamo fixture; dodajemo test čim dobijemo primjer iz logova)

---

## 6. Logging strategy za prvi val

Tijekom prva 2 tjedna nakon enable-a feature-a po salonu:

- Svaka inbound poruka s `attachments.length > 0` loguje `raw_content` na info nivou (s contact ID anonimiziranim)
- Svaki fetch attempt loguje status code, response time, content length, content-type header
- Svaki sharp process loguje input format, input size, output size, processing time
- Svaki LLM poziv loguje broj image content blocks i ukupne bytes poslane

Ovi log-ovi ne idu u DB — samo postojeći pino logger / Render log stream.

Cilj: prikupiti dovoljno realnog payload-a da empirijski riješimo otvorena pitanja:
- Da li GHL forwarda one-time view? U kojem payload obliku?
- Koliko traju GHL pre-signed URL-ovi (kad počinju 404)?
- Koliko često stiže HEIC ili neuobičajeni format?
- Tipična distribucija veličina/formata stvarnih klijentskih slika

---

## 7. Rollout plan

1. **Deploy s `enabled: true` kao default** u Zod shemi.
2. **Prije deploy-a, ručno postavljanje `false` za sve postojeće salone:**
   ```sql
   UPDATE salons SET config = config || '{"image_processing":{"enabled":false}}'::jsonb;
   ```
3. **Enable na 1 test salon** (osobni IG ili pilot salon).
4. **Pratiti 2-3 dana** — vision response quality, fetch failure rate, troškove.
5. **Postepeno enable na ostale salone** kad je signal dovoljan.

Feature flag mehanizam dolazi iz postojećeg config sloja — nema novog toolinga.

---

## 8. Out of scope (v1)

- Voice memo transkripcija (audio = escalate)
- Video frame extraction (video = escalate)
- HEIC ili SVG podrška (uvijek escalate)
- Per-message image count limit (relijemo na kompresiju + auto-cache)
- Object storage za retroaktivni audit (URL ekspiracija prihvaćena)
- Vision model capability auto-detection (escalate na LLM error)
- Per-salon vision prompt override
- One-time view posebni path (defensive `image_without_url` escalation pokriva to dok ne dobijemo realne primjere u logu)
- Image dedup po URL-u (rijetko se događa, dodatna kompleksnost)

---

## 9. Open questions (monitor and learn, ne blokiraju v1)

1. **View-once Instagram payload** — što GHL stvarno forwarda? Defensive escalation pokriva u v1; logging će razriješiti za v2.
2. **GHL pre-signed URL TTL** — koliko dugo URL-ovi traju? Log analysis nakon 2 tjedna.
3. **HEIC u praksi** — Instagram konvertira Instagram-side, ali 3rd party klijenti mogu poslati. Ako > 1/mjesec, dodajemo libvips HEIC support.

---

## 10. References

- Anthropic vision docs: https://docs.anthropic.com/en/docs/build-with-claude/vision
- OpenAI vision docs: https://platform.openai.com/docs/guides/vision
- OpenAI prompt caching: https://platform.openai.com/docs/guides/prompt-caching
- Sharp documentation: https://sharp.pixelplumbing.com/
- GHL attachments overview: https://help.gohighlevel.com/support/solutions/articles/155000001323-attachments-made-easy-in-conversations
- Meta Instagram webhooks: https://developers.facebook.com/docs/messenger-platform/instagram/features/webhook/
