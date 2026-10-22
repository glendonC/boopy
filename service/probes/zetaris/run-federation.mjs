import { spawn } from 'node:child_process';
import { chmod, lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
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
  if (
    (mode === 'reference'
      ? process.argv.length !== 5 || !['Q25391', 'Q8514', 'Q71516'].includes(referenceId)
      : process.argv.length !== 4) ||
    !['discover', 'register', 'join', 'provision-reader', 'verify-reader', 'reference'].includes(
      mode,
    )
  )
    throw new Error();
  const lines = await credentials(credentialsPath);
  const reader =
    mode === 'provision-reader'
      ? await credentials(process.env.BOOPY_PROBE_READER_CREDENTIAL_FILE)
      : [];
  classes = await mkdtemp(join(tmpdir(), 'boopy-federation-'));
  await chmod(classes, 0o700);
  await run(join(jdk, 'bin/javac'), ['--release', '8', '-d', classes, source], undefined, 15000);
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
    `${[...lines, ...reader].join('\n')}\n`,
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
  if (classes) await rm(classes, { recursive: true, force: true });
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

async function credentials(path) {
  if (!path) throw new Error();
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.mode & 0o077 || metadata.size > 4096) throw new Error();
  const lines = (await readFile(path, 'utf8')).split(/\r?\n/);
  if (!lines[0] || !lines[1] || lines.slice(2).some(Boolean)) throw new Error();
  return lines.slice(0, 2);
}
