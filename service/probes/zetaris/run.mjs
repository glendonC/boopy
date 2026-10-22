import { spawn } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeReceipt } from './receipt.mjs';

const source = join(dirname(fileURLToPath(import.meta.url)), 'JdbcSmoke.java');
const jdk =
  process.env.BOOPY_PROBE_JDK ??
  '/Applications/Unity/Hub/Editor/6000.3.25f1/PlaybackEngines/AndroidPlayer/OpenJDK';
const jar = process.env.BOOPY_PROBE_JAR;
const credentialFile = process.argv[2];
const mode = process.argv[3];
let classes;
try {
  if (!jar || !credentialFile || (mode !== undefined && mode !== '--metadata')) throw new Error();
  const metadata = await stat(credentialFile);
  if (!metadata.isFile() || (metadata.mode & 0o077) !== 0 || metadata.size > 4096)
    throw new Error();
  const credentials = await readFile(credentialFile, 'utf8');
  const lines = credentials.split(/\r?\n/);
  if (!lines[0] || !lines[1] || lines.slice(2).some(Boolean)) throw new Error();
  classes = await mkdtemp(join(tmpdir(), 'boopy-jdbc-probe-'));
  await chmod(classes, 0o700);
  await run(
    join(jdk, 'bin/javac'),
    ['--release', '8', '-d', classes, source],
    undefined,
    15000,
    false,
  );
  await run(
    join(jdk, 'bin/java'),
    [
      '-Djava.net.preferIPv4Stack=true',
      '-cp',
      `${classes}:${jar}`,
      'JdbcSmoke',
      ...(mode ? [mode] : []),
    ],
    `${lines[0]}\n${lines[1]}\n`,
    23000,
    true,
  );
} catch {
  console.error('Synthetic JDBC probe failed; no credentials or driver errors are reported.');
  process.exitCode = 1;
} finally {
  if (classes) await rm(classes, { recursive: true, force: true });
}
function run(binary, args, stdin, timeoutMs, report) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      stdio: ['pipe', 'pipe', 'ignore'],
      env: { PATH: '/usr/bin:/bin' },
    });
    let output = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.length > 4096) child.kill('SIGKILL');
    });
    child.stdin.on('error', () => {});
    child.on('error', () => {
      clearTimeout(timer);
      reject(new Error());
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (report) {
        try {
          const result = probeReceipt(output, code);
          console.log(JSON.stringify(result));
        } catch {
          reject(new Error());
          return;
        }
      }
      if (code === 0) resolve();
      else reject(new Error());
    });
    child.stdin.end(stdin);
  });
}
