/**
 * Which LLM API failures are worth retrying.
 *
 * The generation loop used to retry EVERY exception three times. For a
 * deterministic failure that is three identical errors, ~2s of pointless delay,
 * and three times the log noise — for exactly the failures that never recover on
 * their own. Production 2026-07-21: the OpenAI balance ran out and every inbound
 * burned three calls before escalating.
 *
 * Retry transient failures (network, timeout, 5xx, genuine rate limiting).
 * Do not retry deterministic ones: a bad request, an invalid key, a retired
 * model, or an exhausted quota. Those need a human, not another attempt.
 */

/** Quota/billing exhaustion arrives as 429 but never clears by retrying. */
const DETERMINISTIC_429 = /insufficient_quota|exceeded your current quota|billing|payment|hard limit/i;

export function isRetryableLlmError(err: unknown): boolean {
  const e = err as { status?: unknown; code?: unknown; message?: unknown } | null;
  const status = typeof e?.status === 'number' ? e.status : undefined;
  const code = typeof e?.code === 'string' ? e.code : '';
  const message = typeof e?.message === 'string' ? e.message : '';

  if (DETERMINISTIC_429.test(`${code} ${message}`)) return false;

  // No HTTP status at all: a socket error, DNS failure, or client-side timeout.
  // Those are the classic transient cases, so retry.
  if (status === undefined) return true;

  if (status === 429) return true; // genuine rate limit, backoff helps
  if (status >= 500) return true; // provider-side blip
  return false; // 400 bad request, 401 bad key, 403, 404 retired model
}
