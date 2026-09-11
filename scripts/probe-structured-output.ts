/**
 * Throwaway probe: would a mandatory schema field make the model express the
 * escalation it already intends?
 *
 * Four QA rounds have failed the same way. The model writes the handoff sentence
 * and does not fire escalate_to_owner, so nothing reaches the owner. Round 5's T1
 * is the clearest case: the reply said "i'll also let Renata know" and no
 * notification existed. The intent was there; the optional side-channel was not
 * used.
 *
 * This answers, before any migration, whether making the reason a required field
 * of the response changes that. It calls the real API with the real system prompt
 * and NO tools, using response_format json_schema with strict: true. Nothing in
 * production is touched and no test is rewritten.
 *
 * Four cases, and the third matters as much as the first two: a required field can
 * push a model to fill it in when it should not, so an ordinary question has to
 * come back with a null reason or the schema has traded one failure for another.
 *
 *   node --env-file=.env node_modules/.bin/tsx scripts/probe-structured-output.ts
 *   (or set OPENAI_API_KEY and DATABASE_URL in the environment first)
 */
import { readFileSync } from 'node:fs';
import OpenAI from 'openai';
import { createKyselyDb } from '../src/db/kysely.js';
import * as salonsRepo from '../src/db/repos/salons.js';
import { buildPrompt } from '../src/prompt/build.js';
import type { ConversationContext, Salon } from '../src/core/types.js';
import type { ProcessedImage } from '../src/images/process.js';

const LOCATION_ID = process.env.PROBE_LOCATION_ID ?? 'trlNUjhdDfO3pBdmojxs';
const MODEL = process.env.PROBE_MODEL ?? 'gpt-4o';
const IMAGE_PATH = process.env.PROBE_IMAGE ?? 'tests/unit/images/fixtures/small-800x600.jpg';

// Every reason the master prompt defines, plus correction_lead, which is the one
// T1 needs and the one the model keeps failing to send.
const REASONS = [
  'refund_request',
  'vip_client',
  'medical_question',
  'explicit_request_for_owner',
  'this_salon_complaint',
  'unanswered_question',
  'client_refused_consultation_path',
  'hostile_language',
  'correction_lead',
] as const;

/**
 * Flat on purpose. A nested object behind anyOf is legal in strict mode but adds
 * a second thing that can fail, and the probe is meant to test one idea.
 */
const SCHEMA = {
  name: 'salon_reply',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['reply', 'escalation_reason', 'escalation_context'],
    properties: {
      reply: {
        type: 'string',
        description: 'The message the client reads. Plain sentences, no JSON, no bracket notation.',
      },
      escalation_reason: {
        anyOf: [{ type: 'string', enum: [...REASONS] }, { type: 'null' }],
        description: 'The reason the owner is being notified, or null when this turn needs nobody.',
      },
      escalation_context: {
        anyOf: [{ type: 'string' }, { type: 'null' }],
        description: 'One sentence for the owner about what the client wants. Null when escalation_reason is null.',
      },
    },
  },
} as const;

/**
 * Section 12 of the prompt now carries this contract itself, so by default the
 * probe appends nothing and measures the prompt exactly as production sends it.
 *
 * Kept behind PROBE_APPEND_CONTRACT=1 because it is the control: if a case fails
 * against the rewritten prompt, running it again with the append says whether the
 * schema stopped working or the prompt did.
 */
const APPEND = process.env.PROBE_APPEND_CONTRACT === '1';

const OUTPUT_CONTRACT = `

## OUTPUT FORMAT (overrides the tool-call notation above)

You do not call tools. You return one JSON object with three fields.

- reply: what the client reads. Everything the sections above say about voice,
  length, the booking link, and what you must never say applies to this field
  exactly as written. Never put bracket notation or JSON inside it.
- escalation_reason: where the sections above tell you to call
  escalate_to_owner(reason="X"), put X here instead. When no trigger applies this
  turn, null.
- escalation_context: one sentence for the owner, or null.

Setting escalation_reason IS the handoff. It is the only thing that reaches her,
and it replaces the tool call everywhere above. A correction lead sets
escalation_reason to "correction_lead" and still says nothing to the client about
it.`;

function fakeSalonFallback(): Salon {
  const fixture = JSON.parse(readFileSync('tests/e2e/fixtures/salon-lumen.json', 'utf8'));
  return {
    id: 'probe',
    displayName: fixture.display_name,
    ghlLocationId: fixture.ghl_location_id,
    ghlPit: 'unused',
    sourceOfTruth: fixture.source_of_truth,
    config: fixture.config,
    isActive: true,
  } as Salon;
}

async function loadSalon(): Promise<{ salon: Salon; source: string }> {
  const url = process.env.DATABASE_URL;
  if (!url || url.includes('localhost')) {
    return { salon: fakeSalonFallback(), source: 'tests/e2e/fixtures/salon-lumen.json (no remote DATABASE_URL)' };
  }
  const db = createKyselyDb(url);
  try {
    const salon = await salonsRepo.findByLocationId(db, LOCATION_ID, process.env.PIT_ENCRYPTION_KEY);
    if (!salon) return { salon: fakeSalonFallback(), source: `fixture (no salon for ${LOCATION_ID})` };
    return { salon, source: `production DB, location ${LOCATION_ID}` };
  } finally {
    await db.destroy();
  }
}

const msg = (
  id: string,
  direction: 'inbound' | 'outbound',
  text: string | null,
  channelType = 'text',
): ConversationContext['recentMessages'][number] => ({
  id,
  conversationId: 'probe',
  direction,
  channelType,
  textContent: text,
  aiRawOutput: null,
  sanitizeMods: null,
  ghlMessageId: null,
  createdAt: new Date(),
  rawContent: null,
});

const ctx = (msgs: ConversationContext['recentMessages']): ConversationContext => ({
  conversation: {
    id: 'probe',
    salonId: 'probe',
    ghlContactId: 'probe',
    ghlConversationId: null,
    clientHandle: null,
    state: {},
    handoffUntil: null,
    lastMessageAt: null,
  },
  recentMessages: msgs,
  recentEvents: [],
});

function processedImage(): ProcessedImage {
  const bytes = readFileSync(IMAGE_PATH);
  return {
    base64: bytes.toString('base64'),
    mediaType: 'image/jpeg',
    width: 800,
    height: 600,
    bytesIn: bytes.length,
    bytesOut: bytes.length,
  };
}

interface Case {
  label: string;
  expect: string;
  messages: ConversationContext['recentMessages'];
  images?: Map<string, ProcessedImage[]>;
}

function cases(): Case[] {
  const imgs = new Map<string, ProcessedImage[]>([['m1', [processedImage()]]]);
  return [
    {
      label: 'A · correction lead, text only, unambiguous',
      expect: 'correction_lead',
      messages: [msg('m1', 'inbound', 'i dyed my hair at home and it went orange, can you fix it')],
    },
    {
      label: 'B · T1 shape, photo plus "can you fix this"',
      expect: 'correction_lead',
      messages: [msg('m1', 'inbound', 'can you fix this', 'image')],
      images: imgs,
    },
    {
      label: 'C · CONTROL, ordinary question, must NOT escalate',
      expect: 'null',
      messages: [msg('m1', 'inbound', 'how much is balayage and do you take card')],
    },
    {
      label: 'D · T3 shape, client asks for the owner',
      expect: 'explicit_request_for_owner',
      messages: [msg('m1', 'inbound', 'can i just talk to renata directly?')],
    },
  ];
}

async function main(): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set');

  const { salon, source } = await loadSalon();
  const client = new OpenAI({ apiKey, timeout: 60_000, maxRetries: 0 });

  console.log('='.repeat(78));
  console.log('Structured-output probe');
  console.log('  model        ', MODEL);
  console.log('  salon config ', source);
  console.log('  image        ', IMAGE_PATH);
  console.log('  appended     ', APPEND ? 'yes (control run)' : 'no, the prompt carries it');
  if (APPEND) console.log(OUTPUT_CONTRACT.split('\n').map((l) => `    ${l}`).join('\n'));
  console.log('='.repeat(78));

  const results: Array<{ label: string; expect: string; got: string; ok: boolean }> = [];

  for (const [i, c] of cases().entries()) {
    if (i > 0) {
      // ~16.5k input tokens a call against a 30k TPM ceiling. Spacing them is
      // cheaper than reading four 429s.
      console.log('\n(waiting 35s for the token window)');
      await new Promise((r) => setTimeout(r, 35_000));
    }

    const prompt = buildPrompt({
      salon,
      ctx: ctx(c.messages),
      bookingLinkRecentlySent: false,
      imagesByMessageId: c.images ?? new Map(),
    });

    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: 'system', content: APPEND ? prompt.systemPrompt + OUTPUT_CONTRACT : prompt.systemPrompt },
      ...prompt.messages.map((m) =>
        typeof m.content === 'string'
          ? ({ role: m.role, content: m.content } as OpenAI.Chat.Completions.ChatCompletionMessageParam)
          : ({
            role: m.role,
            content: m.content.map((b) =>
              b.type === 'text'
                ? { type: 'text' as const, text: b.text }
                : { type: 'image_url' as const, image_url: { url: `data:${b.mediaType};base64,${b.base64}` } },
            ),
          } as OpenAI.Chat.Completions.ChatCompletionMessageParam),
      ),
    ];

    console.log(`\n${'─'.repeat(78)}\n${c.label}`);
    console.log(`  client says   ${c.messages.map((m) => m.textContent ?? '[photo]').join(' | ')}`);
    console.log(`  expecting     escalation_reason = ${c.expect}`);

    try {
      const res = await client.chat.completions.create({
        model: MODEL,
        messages,
        max_tokens: 512,
        response_format: { type: 'json_schema', json_schema: SCHEMA as never },
      });

      const choice = res.choices[0];
      const raw = choice.message.content ?? '';
      if (choice.message.refusal) {
        console.log(`  REFUSAL       ${choice.message.refusal}`);
        results.push({ label: c.label, expect: c.expect, got: 'refusal', ok: false });
        continue;
      }

      const parsed = JSON.parse(raw) as {
        reply: string;
        escalation_reason: string | null;
        escalation_context: string | null;
      };
      const got = parsed.escalation_reason ?? 'null';

      console.log(`  finish_reason ${choice.finish_reason}`);
      console.log(`  tokens        in ${res.usage?.prompt_tokens} / out ${res.usage?.completion_tokens}`);
      console.log(`  reply         ${parsed.reply}`);
      console.log(`  reason        ${got}`);
      console.log(`  context       ${parsed.escalation_context ?? 'null'}`);
      // A reply carrying tool notation or JSON would mean the contract leaked
      // into the client-visible field, which is the one thing that must not happen.
      // Scoped to the prompt's own notation. A bracketed URL is a formatting slip
      // the sanitizer handles, not a leak of the machinery.
      const leak = /escalation_reason|escalation_context|state_flag_|escalate_to_owner|\[\w+\(/.test(
        parsed.reply,
      );
      if (leak) console.log('  LEAK          reply contains the prompt notation');
      results.push({ label: c.label, expect: c.expect, got, ok: got === c.expect && !leak });
    } catch (err) {
      const e = err as { status?: number; message?: string };
      console.log(`  ERROR         ${e.status ?? ''} ${e.message ?? String(err)}`);
      results.push({ label: c.label, expect: c.expect, got: 'error', ok: false });
    }
  }

  console.log(`\n${'='.repeat(78)}\nSUMMARY`);
  for (const r of results) {
    console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.label}\n        expected ${r.expect}, got ${r.got}`);
  }
  console.log('='.repeat(78));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
