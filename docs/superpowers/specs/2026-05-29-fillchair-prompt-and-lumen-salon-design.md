# Fillchair Prompt + Lumen Salon Design

**Status**: Approved (brainstorming output)
**Date**: 2026-05-29
**Owner**: Ivan
**Predecessor**: [`2026-05-20-instagram-image-handling-v1-design.md`](./2026-05-20-instagram-image-handling-v1-design.md)
**Scope**: Zamjena hardkodiranog system prompta novim (`master_prompt_fillchair.md`, autor: kolega), prelazak na novu SOT strukturu, i zamjena test salona (Bella → Lumen Hair Studio) uz reuse iste GHL lokacije. Tools, image pipeline, sanitizer, GHL klijent i config schema ostaju nepromijenjeni.

---

## 0. Context

Trenutni system prompt je hardkodiran kao JS template literal u `src/prompt/build.ts` i interpolira vrijednosti iz stare SOT strukture (`sot.salon.{name, owner_first_name, booking_link}`). Kolega je napisao novi, znatno detaljniji prompt (`master_prompt_fillchair.md`) dizajniran da model čita vrijednosti iz appended knowledge base JSON-a, te novi SOT format (`Lumen_Hair_Studio_SOT.json`) s drugačijom strukturom (`salon_basics`, `service_menu`, `pricing[]`, `booking`, `price_quoting_policy`, `faq[]`, ...).

Cilj: ubaciti novi prompt u kod, prilagoditi SOT schemu i sve code-paths koji čitaju SOT, te zamijeniti test salon Bella s Lumen-om (reuse iste GHL lokacije radi očuvanja postojećeg IG/workflow setupa).

### 0.1 Decisions table

| Decision | Value |
|---|---|
| Prompt storage | Zaseban fajl `src/prompt/master-prompt.md`, učitan jednom na startu. Izbjegava backtick-escaping (prompt koristi ~40 inline backtick-ova) i omogućuje kolegi editiranje bez TS-a. |
| Variable handling | **Hybrid** — prompt static (model čita owner ime, price policy, faq iz KB), ALI booking URL dodatno interpoliran verbatim na vrh ("paste exactly") jer je kritičan za konverziju i modeli ga znaju mangleati. |
| SOT schema strictness | **Medium** — strogo validira `salon_basics.owner_first_name`, `salon_basics.salon_name`, `booking.url`, `price_quoting_policy` (enum a/b/c). Sve ostalo `.passthrough()` (preživljava u KB dump). |
| Bella's fate | Bella se uklanja kao sadržaj; salon red se UPDATE-a in-place (zadržava `ghl_location_id`, `ghl_pit`, `config`, custom field IDs) — mijenja se samo `display_name` + `source_of_truth` → Lumen. |
| GHL binding | Lumen reusa Bellinu GHL lokaciju (`trlNUjhdDfO3pBdmojxs`), PIT i custom field ID-eve. Postojeći IG connection + workflow nastavljaju raditi bez novog setupa. |
| Clean slate | Brišu se sve conversations (+ messages, conversation_events, escalations) vezane za taj salon prije testiranja, da Lumen testovi kreću od nule. |
| Unchanged | Tools (escalate_to_owner, mark_link_sent, set_state_flag), image pipeline, sanitizer, GHL klijent, salon-config-schema, gpt-4o default model. |

---

## 1. Architecture / data flow

Prompt assembly (novi `buildPrompt` output):

```
┌─ Booking URL header (HYBRID interpolacija, prepended)
│    "The booking URL is: <booking.url>
│     Paste it exactly, character for character, whenever you share it."
│
├─ master-prompt.md  (STATIC — učitan iz fajla, identičan za sve salone)
│    IDENTITY, VOICE, CONVERSATION STATE rules, KB NAVIGATION,
│    RESPONSE FORMAT, ANTI-AI DISCIPLINE, BOOKING BEHAVIOR, PHOTO HANDLING,
│    PRICE QUOTING, HANDOFF, TOOL USAGE, examples...
│
├─ # Conversation state  (DYNAMIC — generiran po turn-u)
│    - Booking link sent in last <N> messages: <bool>
│    - Total inbound messages this conversation: <count>
│    - State flags JSON: <JSON.stringify(state)>
│
└─ # Knowledge base  (DYNAMIC — cijeli SOT JSON)
     <JSON.stringify(sot, null, 2)>
```

Razlozi za ovaj redoslijed:
- **Booking URL na vrhu** — prominentno, model ga vidi rano, ima ga verbatim neovisno o tome čita li KB ispravno
- **master-prompt.md** referira `# Conversation state` (u "HOW TO READ YOUR CONVERSATION STATE") i `# Knowledge base` (u "KNOWLEDGE BASE NAVIGATION") — pa oba moraju postojati i KB mora biti na kraju, što prompt eksplicitno očekuje ("included at the end of your system prompt")
- **Conversation state labels** se točno poklapaju s onim što prompt instruira da čita

Runtime tijek (nepromijenjen od image-handling feature-a):
```
IG DM → GHL webhook → handle-inbound (klasifikacija, escalation prečaci)
                          → respond queue → generate-response
                              → image fetch+process (ako ima slika)
                              → buildPrompt (novi format)
                              → gpt-4o
                              → sanitizer → GHL sendMessage
```

---

## 2. Component design

### 2.1 Prompt storage + loading

**Novi fajl:** `src/prompt/master-prompt.md` — sadržaj `master_prompt_fillchair.md` verbatim (uključujući 🤍 emoji, ispravno UTF-8 encoded — paziti da se `ð¤` artefakt iz copy-paste-a ne unese; mora biti pravi 🤍).

**Loading modul:** `src/prompt/load-master-prompt.ts`:
```typescript
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let cached: string | null = null;

export function loadMasterPrompt(): string {
  if (cached !== null) return cached;
  const here = dirname(fileURLToPath(import.meta.url));
  cached = readFileSync(join(here, 'master-prompt.md'), 'utf-8');
  return cached;
}
```

Učitava se relativno uz compiled modul (`dist/prompt/load-master-prompt.js` → `dist/prompt/master-prompt.md`). Cache-ira nakon prvog čitanja (prompt se ne mijenja u runtime-u).

**Build step:** `tsc` ne kopira `.md` fajlove u `dist/`. Dodati postbuild copy u `package.json`:
```json
"build": "tsc && node scripts/copy-assets.mjs"
```
`scripts/copy-assets.mjs` kopira `src/prompt/*.md` → `dist/prompt/`. (Alternativa: `copyfiles` npm paket, ali vlastiti node skript izbjegava novu dependency.)

### 2.2 SOT schema (`src/core/sot-schema.ts`)

Potpuna zamjena. Medium strictness:

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

- `.passthrough()` na svim razinama čuva nepoznata polja (cijeli bogati SOT preživljava za KB dump)
- Strogo validira samo ono što kod/model kritično trebaju
- `price_quoting_policy` enum hvata tipo (npr. `"B"` ili `"banana"`)

**Napomena o tipovima:** kod pristupa samo `sot.salon_basics.owner_first_name` i `sot.booking.url` — oba su typed. Ostatak SOT-a je dostupan kao passthrough (untyped) ali se samo `JSON.stringify`-a u KB.

### 2.3 buildPrompt restructure (`src/prompt/build.ts`)

Trenutni ~220-linijski template literal se uklanja. Nova funkcija:

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
Paste it exactly, character for character, whenever you share it. Never paraphrase, shorten, or describe it.
`;

  const conversationState = `# Conversation state
- Booking link sent in last ${salon.config.booking_link_dedup_window} messages: ${bookingLinkRecentlySent}
- Total inbound messages this conversation: ${inboundCount}
- State flags JSON: ${JSON.stringify(state)}`;

  const knowledgeBase = `# Knowledge base
${JSON.stringify(sot, null, 2)}`;

  const systemPrompt = [
    bookingHeader,
    loadMasterPrompt(),
    conversationState,
    knowledgeBase,
  ].join('\n\n');

  // Message assembly — UNCHANGED from image-handling feature (multimodal ContentBlock[]).
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

Message assembly logika (multimodal) ostaje identična — samo system prompt assembly se mijenja.

### 2.4 Code path updates (SOT reads)

| Fajl:linija | Stara | Nova |
|---|---|---|
| `generate-response.ts` (sanitizer bookingLink) | `salon.sourceOfTruth.salon.booking_link` | `salon.sourceOfTruth.booking.url` |
| `generate-response.ts` (escalation fallback owner) | `salon.sourceOfTruth.salon.owner_first_name` | `salon.sourceOfTruth.salon_basics.owner_first_name` |
| `generate-response.ts` (contains-link check) | `salon.sourceOfTruth.salon.booking_link` | `salon.sourceOfTruth.booking.url` |
| `handle-inbound.ts` (canned reassurance owner) | `salon.sourceOfTruth.salon.owner_first_name` | `salon.sourceOfTruth.salon_basics.owner_first_name` |

(`build.ts` reads su pokriveni u 2.3.)

### 2.5 Što se NE mijenja

- `src/prompt/tools.ts` — novi prompt opisuje escalate_to_owner/mark_link_sent/set_state_flag; postojeći tool schema ih već podržava. Novi escalation reason stringovi ("this_salon_complaint", "refund_request", itd.) su slobodni stringovi — nema schema promjene.
- `set_state_flag` keys (`client_is_hesitant`, `last_quoted_service`) — poklapaju se s ALLOWED_STATE_KEYS.
- Image pipeline, sanitizer, GHL klijent, salon-config-schema.
- gpt-4o kao default (već postavljeno).

---

## 3. Test / fixture migration

Sve fixtures koje konstruiraju `sourceOfTruth` sa starom strukturom (`salon.{name, owner_first_name, booking_link}`) prelaze na novu (`salon_basics.{...}`, `booking.url`, `price_quoting_policy`).

**Novi fixture:** `tests/e2e/fixtures/salon-lumen.json` — puna Lumen SOT struktura + config (s `ghl_custom_field_ids`, `image_processing`, `llm_model: gpt-4o`). Stari `salon-bella.json` se uklanja ili zamjenjuje.

**Fajlovi za update:**
- `tests/e2e/fixtures/salon-bella.json` → `salon-lumen.json` (svi e2e specovi koji rade `sourceOfTruth: fixture.source_of_truth` automatski dobiju novu strukturu kroz fixture)
- `tests/e2e/03-escalate-tool.spec.ts` — pristupa `fixture.source_of_truth.salon.owner_first_name` → `salon_basics.owner_first_name`
- `tests/e2e/06-image-handling.spec.ts` — pristupa `fixture.source_of_truth.salon.booking_link` → `booking.url`
- (ostali e2e 01/02/04/05 samo učitavaju fixture, ne pristupaju putanjama — dovoljan je novi fixture)
- `tests/unit/prompt/build.spec.ts` — `makeSalon()` sourceOfTruth → nova struktura
- `tests/unit/core/canned-messages.spec.ts` — `sourceOfTruth: { salon: { owner_first_name } }` → `{ salon_basics: { owner_first_name } }`
- `tests/unit/core/handle-inbound.spec.ts` — sourceOfTruth construct → nova struktura
- `tests/unit/core/generate-response-images.spec.ts` — sourceOfTruth → nova struktura
- `tests/unit/core/auth-fail.spec.ts` — sourceOfTruth → nova struktura
- `tests/unit/ghl/factory.spec.ts` — `sourceOfTruth: { salon: { booking_link } }` → `{ booking: { url } }`

**Napomena:** `build.spec.ts` testovi provjeravaju `result.messages` strukturu (string vs ContentBlock[]), ne sadržaj system prompta — strukturno preživljavaju, samo fixture paths se ažuriraju. Ako neki test asertira na specifičan prompt tekst (npr. staru "# Personality" sekciju), preformulira se da provjerava prisutnost ključnih novih markera (npr. da systemPrompt sadrži booking URL i KB JSON).

**Novi unit test:** `tests/unit/prompt/load-master-prompt.spec.ts` — provjerava da loadMasterPrompt vrati neprazan string i da sadrži ključne sekcije (npr. "IDENTITY AND VOICE", "PHOTO HANDLING").

**Novi unit test za schemu:** `tests/unit/core/sot-schema.spec.ts` — validira da Lumen SOT prolazi, da SOT bez `salon_basics.owner_first_name` puca, da `price_quoting_policy: "x"` puca, da passthrough polja (faq, pricing) prežive.

---

## 4. Data migration (production)

Lumen reusa Bellinu GHL lokaciju → in-place update postojećeg salon reda.

**Korak 1 — Clean slate (obriši conversation povijest):**
```sql
-- Pronađi salon
-- salon_id = 'bc886868-f2e0-4326-a743-eb2ade42c1cb' (Bella, postaje Lumen)

-- Obriši dependent rows (redoslijed zbog FK):
DELETE FROM conversation_events WHERE conversation_id IN
  (SELECT id FROM conversations WHERE salon_id = 'bc886868-f2e0-4326-a743-eb2ade42c1cb');
DELETE FROM escalations WHERE conversation_id IN
  (SELECT id FROM conversations WHERE salon_id = 'bc886868-f2e0-4326-a743-eb2ade42c1cb');
DELETE FROM messages WHERE conversation_id IN
  (SELECT id FROM conversations WHERE salon_id = 'bc886868-f2e0-4326-a743-eb2ade42c1cb');
DELETE FROM conversations WHERE salon_id = 'bc886868-f2e0-4326-a743-eb2ade42c1cb';
```
(Točan redoslijed i set tablica potvrditi protiv `0001_initial.ts` FK constraints; ako postoji ON DELETE CASCADE, dovoljno je obrisati conversations.)

**Korak 2 — Update salon sadržaja (Bella → Lumen):**
```sql
UPDATE salons
SET display_name = 'Lumen Hair Studio',
    source_of_truth = '<Lumen SOT JSON>'::jsonb,
    updated_at = now()
WHERE id = 'bc886868-f2e0-4326-a743-eb2ade42c1cb';
```
Zadržava: `ghl_location_id`, `ghl_pit`, `config` (image_processing, llm_model gpt-4o, ghl_custom_field_ids), `is_active`.

**Izvedba:** kroz scratch skript (kao `scratch/list-salons.ts`) koji koristi `pg` + `DATABASE_URL`, ili kroz postojeći `/admin/salons` endpoint ako podržava update. Skript pristup je sigurniji (transakcija, dry-run prikaz prije).

**Napomena:** Lumen SOT prije inserta mora proći novi `SotSchema.parse` (validacija). Skript to radi prije UPDATE-a.

---

## 5. Testing strategy

- **Unit:** sot-schema (validacija critical + passthrough), load-master-prompt (sadržaj), build (prompt assembly sadrži booking header + conversation state + KB; messages multimodal očuvani)
- **Integration:** postojeći e2e (01-06) prolaze s novim Lumen fixture-om i novim promptom
- **Build:** `npm run build` clean + postbuild kopira .md u dist/
- **Manual (production, nakon deploy-a):** pošalji text + sliku Lumen-u (reused GHL lokacija), provjeri da bot odgovara s Lumen kontekstom (Renata kao owner, GlossGenius booking link, Lumen usluge)

---

## 6. Out of scope

- Per-salon prompt overrides (prompt je i dalje globalan static; varijacija ide kroz SOT KB)
- Multi-salon onboarding runbook
- Promjena tool schema ili dodavanje novih tool-ova
- Promjena image pipeline-a, sanitizer-a, GHL klijenta
- Uklanjanje diagnostic logova iz image-handling feature-a (zaseban cleanup)
- Dual-schema podrška (stari SOT format se napušta potpuno)

---

## 7. Open questions

Nema otvorenih — sve odluke donesene u brainstormingu (file-based prompt, medium schema, hybrid interpolacija, Bella→Lumen in-place update s reuse GHL lokacije, clean slate).
