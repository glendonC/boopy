/**
 * Builds the recorded still helper into `.build/boopy-recorded`. Needs Xcode's Swift compiler.
 *
 *   pnpm recorded:build
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const output = join(root, '.build', 'boopy-recorded');
mkdirSync(dirname(output), { recursive: true });
execFileSync('swiftc', ['-O', '-o', output, join(root, 'tools', 'recorded', 'main.swift')], {
  stdio: 'inherit',
});
console.log(`Built ${output}`);
