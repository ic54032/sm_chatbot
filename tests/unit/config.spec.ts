import { describe, it, expect } from 'vitest';
import { loadConfig } from '../../src/config.js';

describe('config V2 fields', () => {
  it('parses useMockGhl from env, defaults to false', () => {
    const orig = process.env.USE_MOCK_GHL;
    delete process.env.USE_MOCK_GHL;
    const cfg = loadConfig();
    expect(cfg.useMockGhl).toBe(false);
    if (orig !== undefined) process.env.USE_MOCK_GHL = orig;
  });

  it('useMockGhl=true when env says so', () => {
    const orig = process.env.USE_MOCK_GHL;
    process.env.USE_MOCK_GHL = 'true';
    const cfg = loadConfig();
    expect(cfg.useMockGhl).toBe(true);
    if (orig !== undefined) process.env.USE_MOCK_GHL = orig; else delete process.env.USE_MOCK_GHL;
  });

  it('exposes ghlApiBaseUrl and ghlApiVersion with defaults', () => {
    const cfg = loadConfig();
    expect(cfg.ghlApiBaseUrl).toBe('https://services.leadconnectorhq.com');
    expect(cfg.ghlApiVersion).toBe('2021-04-15');
  });
});
