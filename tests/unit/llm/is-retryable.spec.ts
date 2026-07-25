/**
 * Retrying a deterministic API failure three times just triples the latency and
 * the log noise on an outage a human has to fix (production 2026-07-21: the
 * OpenAI balance ran out and every inbound burned three calls).
 */
import { describe, it, expect } from 'vitest';
import { isRetryableLlmError } from '../../../src/llm/is-retryable.js';

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
