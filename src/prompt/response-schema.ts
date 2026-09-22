import { z } from 'zod';

/**
 * The reply contract, as a schema the model cannot return without satisfying.
 *
 * This replaces tool calling. Four QA rounds failed the same way: the model wrote
 * the handoff sentence and did not fire escalate_to_owner, so nothing reached the
 * owner. Round 5's T1 is the clearest case — the reply said "i'll also let Renata
 * know" and no notification existed at all. The intent was there every time; an
 * optional side-channel was not used. A required field is not forgettable in the
 * same way, because it is part of the object the model is already generating.
 *
 * Measured before committing to it (scripts/probe-structured-output.ts, against
 * the real prompt and the real knowledge base): a text correction lead, the T1
 * photo turn, and an owner request all returned the right reason, and — the
 * result that mattered most — an ordinary price question returned null rather than
 * inventing an escalation to fill the field.
 *
 * Everything is flat and nullable-by-anyOf on purpose. Strict mode accepts a
 * nested object behind anyOf, but the probe only proved the flat shapes, and a
 * schema this load-bearing is the wrong place to also be guessing.
 */

/**
 * Reasons the MODEL may choose. Backend-only reasons (llm_failed,
 * sanitizer_empty_output, implied_handoff_no_tool_call, the media reasons) are
 * deliberately absent: the model must not be able to label a turn with a failure
 * that only the backend can observe. escalation-labels.ts maps every reason, both
 * kinds, to what the owner reads.
 *
 * The enum is the single source of truth for this list. It previously lived in
 * three places — the prompt's prose, a validation set for text-form tool calls,
 * and the pause/notify sets — and the validation copy is now this.
 */
export const MODEL_ESCALATION_REASONS = [
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

/** The only per-conversation flags the model may set. */
export const STATE_FLAG_KEYS = ['client_is_hesitant', 'last_quoted_service'] as const;

export const RESPONSE_SCHEMA_NAME = 'salon_reply';

const nullable = (...variants: Array<Record<string, unknown>>) => ({
  anyOf: [...variants, { type: 'null' }],
});

/**
 * OpenAI strict mode has three hard requirements and all three are easy to miss:
 * every object sets additionalProperties false, every property is listed in
 * required, and an optional field is expressed as a nullable one rather than
 * omitted. A field the model should usually leave alone is therefore required and
 * null, not absent.
 */
export const RESPONSE_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: [
    'reply',
    'escalation_reason',
    'escalation_context',
    'consult_objection_answered',
    'state_flag_key',
    'state_flag_value',
  ],
  properties: {
    reply: {
      type: 'string',
      description:
        'The message the client reads. Plain sentences in the voice the system prompt describes. Never JSON, never bracket notation, never a mention of this format.',
    },
    escalation_reason: nullable({ type: 'string', enum: [...MODEL_ESCALATION_REASONS] }),
    escalation_context: nullable({ type: 'string' }),
    consult_objection_answered: nullable({
      type: 'boolean',
      description:
        'True only on a turn where you answered a consultation objection warmly and did NOT hand over. It is how the backend knows this objection has been used up, so the next push goes straight to the owner. Null on every other turn.',
    }),
    state_flag_key: nullable({ type: 'string', enum: [...STATE_FLAG_KEYS] }),
    state_flag_value: nullable({ type: 'string' }, { type: 'boolean' }),
  },
};

/**
 * Strict mode makes a mismatch very unlikely rather than impossible, and a
 * refusal or a truncated response still produce something that is not this shape.
 * The caller treats a parse failure exactly as it treats an empty reply, which is
 * a path that already exists and is already tested.
 *
 * `reply` is validated strictly because without it there is nothing to send. The
 * two label fields are deliberately typed as plain strings and narrowed
 * afterwards, and that split is the whole point: an enum here would fail the
 * WHOLE object over one unrecognised reason and throw away a perfectly good reply
 * with it, turning a mislabelled escalation into a client who got no answer.
 * Constrained decoding makes that unreachable in production, which is exactly why
 * it must not be the thing standing between the client and a reply.
 */
export const LlmReplySchema = z.object({
  reply: z.string(),
  escalation_reason: z.string().nullable(),
  escalation_context: z.string().nullable(),
  // Nullish rather than nullable: strict mode makes the model send it, but a
  // reply object assembled anywhere else (a test, an older stored row, a
  // provider that drops an unknown field) must not fail validation over a flag
  // whose absence simply means "no objection was answered".
  consult_objection_answered: z.boolean().nullish(),
  state_flag_key: z.string().nullable(),
  state_flag_value: z.union([z.string(), z.boolean()]).nullable(),
});

export type LlmReply = z.infer<typeof LlmReplySchema>;

/**
 * An unrecognised reason becomes "unspecified" rather than nothing.
 *
 * The model asked for the owner, so she is told; what it called the reason is not
 * trustworthy enough to put in front of her. "unspecified" reads as "Needs your
 * attention", which is honest. Dropping the escalation instead would lose a real
 * handoff over a spelling, and passing the raw string through would put
 * model-authored, possibly client-quoted text into her GHL field.
 */
export function normaliseEscalationReason(raw: string | null): string | null {
  if (!raw) return null;
  return (MODEL_ESCALATION_REASONS as readonly string[]).includes(raw) ? raw : 'unspecified';
}

/** An unknown flag key is dropped, because nothing depends on it being set. */
export function isStateFlagKey(raw: string | null): raw is (typeof STATE_FLAG_KEYS)[number] {
  return raw !== null && (STATE_FLAG_KEYS as readonly string[]).includes(raw);
}
