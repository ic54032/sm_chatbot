import { describe, it, expect, afterEach, vi } from 'vitest';
import { loadConfig } from '../../src/config.js';

describe('config V2 fields', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('useMockGhl defaults to false when env not set', () => {
    vi.stubEnv('USE_MOCK_GHL', undefined as unknown as string);
    expect(loadConfig().useMockGhl).toBe(false);
  });

  it('useMockGhl=true when env="true"', () => {
    vi.stubEnv('USE_MOCK_GHL', 'true');
    expect(loadConfig().useMockGhl).toBe(true);
  });

  it('useMockGhl=false when env="false" (the .env.example case)', () => {
    vi.stubEnv('USE_MOCK_GHL', 'false');
    expect(loadConfig().useMockGhl).toBe(false);
  });

  it('useMockGhl=true when env="1"', () => {
    vi.stubEnv('USE_MOCK_GHL', '1');
    expect(loadConfig().useMockGhl).toBe(true);
  });

  it('useMockGhl=false when env="0"', () => {
    vi.stubEnv('USE_MOCK_GHL', '0');
    expect(loadConfig().useMockGhl).toBe(false);
  });

  it('ghlApiBaseUrl defaults to GHL services URL', () => {
    vi.stubEnv('GHL_API_BASE_URL', undefined as unknown as string);
    expect(loadConfig().ghlApiBaseUrl).toBe('https://services.leadconnectorhq.com');
  });

  it('ghlApiBaseUrl can be overridden via env', () => {
    vi.stubEnv('GHL_API_BASE_URL', 'https://test.example.com');
    expect(loadConfig().ghlApiBaseUrl).toBe('https://test.example.com');
  });

  it('ghlApiVersion defaults to 2021-04-15', () => {
    vi.stubEnv('GHL_API_VERSION', undefined as unknown as string);
    expect(loadConfig().ghlApiVersion).toBe('2021-04-15');
  });

  it('ghlApiVersion can be overridden via env', () => {
    vi.stubEnv('GHL_API_VERSION', '2023-06-01');
    expect(loadConfig().ghlApiVersion).toBe('2023-06-01');
  });

  it('pitEncryptionKey is optional (undefined when not set)', () => {
    vi.stubEnv('PIT_ENCRYPTION_KEY', undefined as unknown as string);
    expect(loadConfig().pitEncryptionKey).toBeUndefined();
  });

  it('pitEncryptionKey accepts a base64 string of 32 bytes', () => {
    const key = Buffer.from(new Array(32).fill(0)).toString('base64'); // 44 chars
    vi.stubEnv('PIT_ENCRYPTION_KEY', key);
    expect(loadConfig().pitEncryptionKey).toBe(key);
  });
});
