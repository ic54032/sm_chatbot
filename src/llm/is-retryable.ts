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

/**
 * How long to wait before retrying, in milliseconds.
 *
 * On a rate limit OpenAI tells us exactly how long the budget needs, in
 * `retry-after-ms` (or `retry-after`, in seconds). Guessing is worse than
 * reading it: production 2026-08-15 asked for 850ms against our blind 1000ms
 * backoff — close enough by luck. A bigger overage asks for seconds, and the
 * same blind backoff would burn all three attempts inside the window and land
 * on a needless failure, which is exactly how two healthy conversations were
 * stamped `llm_failed` earlier this month.
 *
 * The header wins when it is present and sane; otherwise fall back to
 * exponential backoff. Capped so a worker never parks on one turn for long —
 * beyond that it is better to fail and let the recovery ladder answer.
 */
const MAX_RETRY_DELAY_MS = 10_000;

export function retryDelayMs(err: unknown, attempt: number): number {
  const fallback = 500 * 2 ** attempt;
  const headers = (err as { headers?: Record<string, unknown> } | null)?.headers;
  if (!headers) return fallback;

  const read = (key: string): number | undefined => {
    const raw = headers[key];
    const n = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : NaN;
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  };

  const fromHeader = read('retry-after-ms') ?? (read('retry-after') !== undefined ? read('retry-after')! * 1000 : undefined);
  if (fromHeader === undefined) return fallback;

  // A small jitter keeps concurrent workers from retrying in lockstep.
  const jitter = Math.round(fromHeader * 0.1);
  return Math.min(Math.max(fromHeader + jitter, fallback), MAX_RETRY_DELAY_MS);
}

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
