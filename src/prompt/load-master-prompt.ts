import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let cached: string | null = null;

/** Loads the static master prompt from master-prompt.md (cached after first read). */
export function loadMasterPrompt(): string {
  if (cached !== null) return cached;
  const here = dirname(fileURLToPath(import.meta.url));
  cached = readFileSync(join(here, 'master-prompt.md'), 'utf-8');
  return cached;
}
