import { describe, it, expect } from 'vitest';
import { GhlApiError, OutsideMessagingWindowError, isOutsideWindowError } from '../../../src/ghl/errors.js';

describe('GhlApiError', () => {
  it('preserves status, path, body', () => {
    const err = new GhlApiError(500, '/conversations/messages', 'internal err');
    expect(err.status).toBe(500);
    expect(err.path).toBe('/conversations/messages');
    expect(err.body).toBe('internal err');
    expect(err.name).toBe('GhlApiError');
  });
});

describe('isOutsideWindowError', () => {
  it('matches 422 with 24-hour window message', () => {
    expect(isOutsideWindowError(422, 'cannot send outside the 24-hour messaging window')).toBe(true);
  });

  it('matches 400 with window word', () => {
    expect(isOutsideWindowError(400, 'Outside 24 hour window')).toBe(true);
  });

  it('rejects 500 even with matching body', () => {
    expect(isOutsideWindowError(500, 'outside 24 hour window')).toBe(false);
  });

  it('rejects 422 without window/messaging words', () => {
    expect(isOutsideWindowError(422, 'validation failed')).toBe(false);
  });

  it('rejects 422 with "24" but no "window" or "messaging"', () => {
    expect(isOutsideWindowError(422, 'expected 24 chars min')).toBe(false);
  });
});

describe('OutsideMessagingWindowError', () => {
  it('is subclass of GhlApiError with status 422', () => {
    const err = new OutsideMessagingWindowError('/p', 'body');
    expect(err).toBeInstanceOf(GhlApiError);
    expect(err.status).toBe(422);
    expect(err.name).toBe('OutsideMessagingWindowError');
  });
});
