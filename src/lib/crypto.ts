import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;
const VERSION_PREFIX = 'enc1:';

function parseKey(keyBase64: string): Buffer {
  const buf = Buffer.from(keyBase64, 'base64');
  if (buf.length !== KEY_BYTES) {
    throw new Error(
      `PIT encryption key must be exactly ${KEY_BYTES} bytes (got ${buf.length}). ` +
        `Generate with: node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"`,
    );
  }
  return buf;
}

export function isEncrypted(value: string): boolean {
  return value.startsWith(VERSION_PREFIX);
}

export function encryptPit(plaintext: string, keyBase64: string): string {
  const key = parseKey(keyBase64);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const payload = Buffer.concat([ciphertext, authTag]);
  return `${VERSION_PREFIX}${iv.toString('base64')}:${payload.toString('base64')}`;
}

export function decryptPit(value: string, keyBase64: string): string {
  if (!isEncrypted(value)) {
    // Backwards-compat: value is plaintext (legacy pre-encryption row).
    return value;
  }
  const key = parseKey(keyBase64);
  const stripped = value.slice(VERSION_PREFIX.length);
  const sepIdx = stripped.indexOf(':');
  if (sepIdx < 0) throw new Error('Malformed encrypted PIT: missing IV separator');
  const iv = Buffer.from(stripped.slice(0, sepIdx), 'base64');
  const payload = Buffer.from(stripped.slice(sepIdx + 1), 'base64');
  if (payload.length < 16) throw new Error('Malformed encrypted PIT: payload too short');
  const ciphertext = payload.subarray(0, payload.length - 16);
  const authTag = payload.subarray(payload.length - 16);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}
