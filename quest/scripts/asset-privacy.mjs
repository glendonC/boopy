import { createHash } from 'node:crypto';
import { closeSync, lstatSync, openSync, readdirSync, readFileSync, readSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mediaKind, mediaName } from './apk-privacy.mjs';

// The owner's footage reaches the headset only by streaming from the Mac. This checks what an APK is built from: every
// file under quest/Assets, git-ignored folders included (StreamingAssets ships in the APK and git never shows it). It
// fails on a media file, found by its name or its first bytes, on a link (which could point anywhere), and on any file
// whose sha256 equals a file in a private folder passed in (the footage, or a still made from it), whatever its name.
// The allowlist is empty: quest/Assets holds no media.

function* files(folder) {
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else yield path;
  }
}

function head(path) {
  const handle = openSync(path, 'r');
  try {
    const bytes = Buffer.alloc(12);
    return bytes.subarray(0, readSync(handle, bytes, 0, 12, 0));
  } finally { closeSync(handle); }
}

const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex');

export function assetFindings(root, privateFolders = []) {
  // Only a file the same size as a private one can be a copy, so only those are hashed.
  const secret = new Map();
  for (const folder of privateFolders)
    for (const path of files(folder)) {
      const stat = lstatSync(path);
      if (!stat.isFile()) continue;
      if (!secret.has(stat.size)) secret.set(stat.size, new Set());
      secret.get(stat.size).add(digest(path));
    }
  const findings = [];
  for (const path of files(root)) {
    const name = relative(root, path).split(sep).join('/');
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) { findings.push(`link ${name}`); continue; }
    if (!stat.isFile()) continue;
    if (secret.get(stat.size)?.has(digest(path))) findings.push(`copy of a private file ${name}`);
    else if (mediaName.test(name) || mediaKind(head(path)) !== null) findings.push(`media file ${name}`);
  }
  return findings;
}

function main() {
  const [root, ...privateFolders] = process.argv.slice(2);
  if (!root) { console.error('Usage: node asset-privacy.mjs <quest/Assets> [private folder]...'); process.exit(2); }
  const findings = assetFindings(root, privateFolders);
  for (const finding of findings) console.log(`Found ${finding}.`);
  if (findings.length) process.exit(1);
  console.log(`No media file or link in ${root}.`);
  if (privateFolders.length) console.log(`No copy of a file from the ${privateFolders.length} private folder(s) in ${root}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
