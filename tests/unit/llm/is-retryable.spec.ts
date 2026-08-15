/**
 * Retrying a deterministic API failure three times just triples the latency and
 * the log noise on an outage a human has to fix (production 2026-07-21: the
 * OpenAI balance ran out and every inbound burned three calls).
 */
import { describe, it, expect } from 'vitest';
import { isRetryableLlmError, retryDelayMs } from '../../../src/llm/is-retryable.js';

const err = (status?: number, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error(String(extra.message ?? 'boom')), { status, ...extra });

describe('isRetryableLlmError — transient failures (RETRY)', () => {
  it('retries a network error with no HTTP status', () => {
    expect(isRetryableLlmError(new Error('socket hang up'))).toBe(true);
  });

  it('retries a client-side timeout', () => {
    expect(isRetryableLlmError(err(undefined, { message: 'Request timed out' }))).toBe(true);
  });

  it('retries provider 5xx', () => {
    expect(isRetryableLlmError(err(500))).toBe(true);
    expect(isRetryableLlmError(err(503))).toBe(true);
  });

  it('retries a genuine rate limit', () => {
    expect(isRetryableLlmError(err(429, { code: 'rate_limit_exceeded' }))).toBe(true);
  });
});

describe('isRetryableLlmError — deterministic failures (DO NOT RETRY)', () => {
  it('does not retry an exhausted quota, even though it arrives as 429', () => {
    expect(isRetryableLlmError(err(429, { code: 'insufficient_quota' }))).toBe(false);
    expect(
      isRetryableLlmError(err(429, { message: 'You exceeded your current quota, please check your plan and billing details.' })),
    ).toBe(false);
  });

  it('does not retry an invalid API key', () => {
    expect(isRetryableLlmError(err(401, { code: 'invalid_api_key' }))).toBe(false);
  });

  it('does not retry a retired or unknown model', () => {
    expect(isRetryableLlmError(err(404, { code: 'model_not_found' }))).toBe(false);
  });

  it('does not retry a malformed request', () => {
    expect(isRetryableLlmError(err(400, { message: "Invalid 'messages[3].content': string too short" }))).toBe(false);
  });

  it('does not retry a forbidden request', () => {
    expect(isRetryableLlmError(err(403))).toBe(false);
  });

  it('tolerates non-error values', () => {
    expect(isRetryableLlmError(null)).toBe(true);
    expect(isRetryableLlmError('nope')).toBe(true);
  });
});

/**
 * Production 2026-08-15 returned `retry-after-ms: 850` on a TPM 429. Our blind
 * backoff happened to be 1000ms, so that one recovered by luck. A larger overage
 * asks for seconds, and guessing would burn all three attempts inside the window.
 */
describe('retryDelayMs', () => {
  const withHeaders = (headers: Record<string, string>) =>
    Object.assign(new Error('429'), { status: 429, headers });

  it('honours retry-after-ms from the response', () => {
    // 850ms + 10% jitter is below the 1000ms fallback, so the larger wins.
    expect(retryDelayMs(withHeaders({ 'retry-after-ms': '850' }), 1)).toBe(1000);
  });

  it('waits the full time the API asks for when that exceeds our backoff', () => {
    const delay = retryDelayMs(withHeaders({ 'retry-after-ms': '4000' }), 1);
    expect(delay).toBeGreaterThanOrEqual(4000);
    expect(delay).toBeLessThanOrEqual(10_000);
  });

  it('falls back to retry-after in seconds when the ms header is absent', () => {
    expect(retryDelayMs(withHeaders({ 'retry-after': '3' }), 1)).toBeGreaterThanOrEqual(3000);
  });

  it('caps the wait so a worker never parks on one turn', () => {
    expect(retryDelayMs(withHeaders({ 'retry-after-ms': '120000' }), 1)).toBe(10_000);
  });

  it('falls back to exponential backoff with no usable header', () => {
    expect(retryDelayMs(new Error('socket hang up'), 1)).toBe(1000);
    expect(retryDelayMs(withHeaders({ 'retry-after-ms': 'soon' }), 2)).toBe(2000);
  });
});
