import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sanitize } from '../../../src/sanitizer/index.js';

const fixturesDir = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures');
const inputs = readdirSync(fixturesDir).filter((f) => f.endsWith('.input.txt'));

const baseCtx = {
  bookingLink: 'https://example.com/book',
  bookingLinkSentInLastNHours: async () => false,
  policy: { maxWordsPerMessage: 40, maxEmojis: 2, bookingLinkDedupWindowHours: 3 },
};

describe('sanitizer fixture corpus', () => {
  for (const inputFile of inputs) {
    const name = inputFile.replace('.input.txt', '');
    it(name, async () => {
      const input = readFileSync(join(fixturesDir, inputFile), 'utf8').trim();
      const expectedFile = join(fixturesDir, `${name}.expected.json`);
      const expected = JSON.parse(readFileSync(expectedFile, 'utf8'));
      const result = await sanitize(input, baseCtx);
      expect(result.messages).toEqual(expected.messages);
      expect(result.modifications.sort()).toEqual(expected.modifications.sort());
    });
  }
});
