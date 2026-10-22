/**
 * Builds the Apple Vision OCR tool into `.build/boopy-ocr`. Needs Xcode's Swift compiler.
 *
 *   pnpm ocr:build
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const output = join(root, '.build', 'boopy-ocr');
mkdirSync(dirname(output), { recursive: true });
execFileSync('swiftc', ['-O', '-o', output, join(root, 'tools', 'ocr', 'main.swift')], {
  stdio: 'inherit',
});
console.log(`Built ${output}`);
