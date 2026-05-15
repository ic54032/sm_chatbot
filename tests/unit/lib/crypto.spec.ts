import { describe, it, expect } from 'vitest';
import { encryptPit, decryptPit, isEncrypted } from '../../../src/lib/crypto.js';

const KEY = Buffer.from(new Array(32).fill(0).map((_, i) => i)).toString('base64'); // deterministic test key

describe('encryptPit / decryptPit', () => {
  it('roundtrip: decrypt(encrypt(x)) === x', () => {
    const plain = 'pit-abc-123-def-456';
    const encrypted = encryptPit(plain, KEY);
    expect(decryptPit(encrypted, KEY)).toBe(plain);
  });

  it('encrypted output starts with version prefix enc1:', () => {
    const encrypted = encryptPit('pit-foo', KEY);
    expect(encrypted.startsWith('enc1:')).toBe(true);
  });

  it('two encrypts of same plaintext produce different ciphertexts (random IV)', () => {
    const a = encryptPit('pit-foo', KEY);
    const b = encryptPit('pit-foo', KEY);
    expect(a).not.toBe(b);
    expect(decryptPit(a, KEY)).toBe(decryptPit(b, KEY));
  });

  it('decryptPit passes through plaintext (backwards-compat with un-encrypted rows)', () => {
    expect(decryptPit('pit-legacy-plaintext', KEY)).toBe('pit-legacy-plaintext');
  });

  it('isEncrypted detects enc1: prefix', () => {
    expect(isEncrypted('enc1:abc:def')).toBe(true);
    expect(isEncrypted('pit-foo')).toBe(false);
  });

  it('decrypt with wrong key throws', () => {
    const wrong = Buffer.from(new Array(32).fill(0).map((_, i) => i + 1)).toString('base64');
    const encrypted = encryptPit('pit-foo', KEY);
    expect(() => decryptPit(encrypted, wrong)).toThrow();
  });

  it('tampered ciphertext throws (GCM auth fails)', () => {
    const encrypted = encryptPit('pit-foo', KEY);
    // Flip a bit in the middle
    const tampered = encrypted.slice(0, -2) + (encrypted.slice(-2) === 'AA' ? 'BB' : 'AA');
    expect(() => decryptPit(tampered, KEY)).toThrow();
  });

  it('parseKey rejects wrong-length key', () => {
    const shortKey = 'short';
    expect(() => encryptPit('x', shortKey)).toThrow();
  });
});
