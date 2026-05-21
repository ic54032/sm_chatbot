import { describe, it, expect, afterEach, vi } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { SalonConfigSchema } from '../../src/core/salon-config-schema.js';

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

describe('SalonConfigSchema image_processing defaults', () => {
  const minimalConfig = {
    ghl_custom_field_ids: {
      needs_owner_attention: 'a',
      bot_paused_until: 'b',
      last_escalation_reason: 'c',
    },
  };

  it('applies defaults when image_processing field is missing', () => {
    const parsed = SalonConfigSchema.parse(minimalConfig);
    expect(parsed.image_processing).toEqual({
      enabled: true,
      max_dimension: 1280,
      jpeg_quality: 80,
    });
  });

  it('respects partial overrides', () => {
    const parsed = SalonConfigSchema.parse({
      ...minimalConfig,
      image_processing: { enabled: false },
    });
    expect(parsed.image_processing).toEqual({
      enabled: false,
      max_dimension: 1280,
      jpeg_quality: 80,
    });
  });

  it('rejects out-of-range max_dimension', () => {
    expect(() =>
      SalonConfigSchema.parse({
        ...minimalConfig,
        image_processing: { max_dimension: 4096 },
      }),
    ).toThrow();
  });
});
