// Copies non-TS assets (prompt .md files) into dist/ after tsc, since tsc only
// emits .js. Keeps the runtime loader's relative read (dist/prompt/master-prompt.md)
// working in production.
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const srcDir = 'src/prompt';
const outDir = 'dist/prompt';

mkdirSync(outDir, { recursive: true });
for (const file of readdirSync(srcDir)) {
  if (file.endsWith('.md')) {
    copyFileSync(join(srcDir, file), join(outDir, file));
    console.log(`copied ${file} -> ${outDir}`);
  }
}
