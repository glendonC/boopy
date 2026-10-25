import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { federationReceipt } from './federation-receipt.mjs';

const source = join(dirname(fileURLToPath(import.meta.url)), 'JdbcFederation.java');
const jdk =
  process.env.BOOPY_PROBE_JDK ??
  '/Applications/Unity/Hub/Editor/6000.3.25f1/PlaybackEngines/AndroidPlayer/OpenJDK';
const jar = process.env.BOOPY_PROBE_JAR;
let classes;
// Whether this call made the classes folder and so removes it; a cached folder stays.
let owned = false;
let active;
let cancelled = false;
const cancel = () => {
  cancelled = true;
  active?.kill('SIGKILL');
};
process.once('SIGTERM', cancel);
process.once('SIGINT', cancel);
try {
  const [credentialsPath, mode, referenceId] = process.argv.slice(2);
  // Each practice mode writes one fixed table; none takes a table name.
  const requests = ['term-pick', 'practice-stage', 'term-pick-check', 'practice-stage-check'];
  if (
    (mode === 'reference'
      ? process.argv.length !== 5 || !['Q25391', 'Q8514', 'Q71516'].includes(referenceId)
      : process.argv.length !== 4) ||
    ![
      'discover',
      'register',
      'join',
      'provision-reader',
      'verify-reader',
      'reference',
      'register-terms',
      'provision-practice',
      'verify-practice',
      ...requests,
    ].includes(mode)
  )
    throw new Error();
  const lines = await credentials(credentialsPath);
  const reader =
    mode === 'provision-reader'
      ? await credentials(process.env.BOOPY_PROBE_READER_CREDENTIAL_FILE)
      : mode === 'provision-practice'
        ? await credentials(process.env.BOOPY_PROBE_PRACTICE_CREDENTIAL_FILE)
        : [];
  // A pick or a stage reads its fixed request lines from stdin; the runner checks them again.
  const request = requests.includes(mode) ? await requestLines() : [];
  classes = await compiledClasses();
  const result = await run(
    join(jdk, 'bin/java'),
    [
      '-Djava.net.preferIPv4Stack=true',
      '-cp',
      [classes, jar].filter(Boolean).join(':'),
      'JdbcFederation',
      mode,
      ...(referenceId ? [referenceId] : []),
    ],
    `${[...lines, ...reader, ...request].join('\n')}\n`,
    63000,
  );
  console.log(JSON.stringify(federationReceipt(result.stdout, result.code, mode)));
  if (result.code !== 0) process.exitCode = 1;
} catch {
  console.error('Isolated federation probe failed; no vendor errors or credentials disclosed.');
  process.exitCode = 1;
} finally {
  process.removeListener('SIGTERM', cancel);
  process.removeListener('SIGINT', cancel);
  if (classes && owned) await rm(classes, { recursive: true, force: true });
}
function run(binary, args, input, timeout) {
  return new Promise((resolve, reject) => {
    if (cancelled) return reject(new Error());
    const child = spawn(binary, args, {
      stdio: ['pipe', 'pipe', 'ignore'],
      env: { PATH: '/usr/bin:/bin' },
    });
    active = child;
    let stdout = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.length > 32768) child.kill('SIGKILL');
    });
    child.stdin.on('error', () => {});
    child.on('error', () => {
      clearTimeout(timer);
      reject(new Error());
    });
    child.on('close', (code) => {
      if (active === child) active = undefined;
      clearTimeout(timer);
      if (input === undefined && code !== 0) reject(new Error());
      else resolve({ stdout, code });
    });
    child.stdin.end(input);
  });
}

/**
 * Classes compiled from this exact source with this JDK, kept in a private folder of this user's
 * and reused by later calls; compiling takes seconds. A folder that is not this user's private
 * directory is never used. Without a compiled class the call uses a fresh folder it removes.
 */
async function compiledClasses() {
  const key = createHash('sha256')
    .update(await readFile(source))
    .update('\0')
    .update(jdk)
    .digest('hex')
    .slice(0, 32);
  const cached = join(tmpdir(), `boopy-federation-cache-${key}`);
  if (await privateWith(cached, 'JdbcFederation.class')) return cached;
  classes = await mkdtemp(join(tmpdir(), 'boopy-federation-'));
  owned = true;
  await chmod(classes, 0o700);
  await run(join(jdk, 'bin/javac'), ['--release', '8', '-d', classes, source], undefined, 15000);
  if (await privateWith(classes, 'JdbcFederation.class')) {
    try {
      await rename(classes, cached);
      owned = false;
      return cached;
    } catch {
      // Another call cached it first; this one keeps its own folder and removes it.
    }
  }
  return classes;
}

async function privateWith(directory, file) {
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.mode & 0o077 || info.uid !== process.getuid()) return false;
    return (await lstat(join(directory, file))).isFile();
  } catch {
    return false;
  }
}

async function requestLines() {
  let text = '';
  for await (const chunk of process.stdin) {
    text += chunk;
    if (text.length > 262144) throw new Error();
  }
  const request = text.split('\n');
  if (request.pop() !== '' || request.at(-1) !== 'end') throw new Error();
  const control = (character) => {
    const code = character.codePointAt(0);
    return (code < 32 && code !== 9) || code === 127;
  };
  if (request.some((line) => Array.from(line).some(control))) throw new Error();
  return request;
}

async function credentials(path) {
  if (!path) throw new Error();
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.mode & 0o077 || metadata.size > 4096) throw new Error();
  const lines = (await readFile(path, 'utf8')).split(/\r?\n/);
  if (!lines[0] || !lines[1] || lines.slice(2).some(Boolean)) throw new Error();
  return lines.slice(0, 2);
}
