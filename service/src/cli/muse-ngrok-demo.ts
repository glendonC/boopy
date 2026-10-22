/** Explicitly authorized fictional-data tunnel only; never imports production configuration. */
import { type ChildProcess, spawn } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { startMuseConnectorDemo } from './muse-connector-demo.ts';
import { startMuseDemoGate } from './muse-demo-gate.ts';

const TTL = 15 * 60 * 1000;
export function ngrokOrigin(value: unknown): string {
  if (typeof value !== 'string') throw new Error();
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.port ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    !/^[a-z0-9-]+\.(ngrok-free\.app|ngrok-free\.dev|ngrok\.app|ngrok\.dev)$/.test(url.hostname)
  )
    throw new Error();
  return url.origin;
}

/** Only these stable local messages may cross the vendor logging boundary. */
export class NgrokDemoError extends Error {
  readonly code: 'account_mismatch' | 'failed';
  constructor(code: 'account_mismatch' | 'failed') {
    super(
      code === 'account_mismatch'
        ? 'The ngrok credential does not match the account that owns the selected domain (ERR_NGROK_320). Update the local ngrok credential for that account, then explicitly retry. No consumer fetch was verified.'
        : 'Synthetic ngrok demo failed; no consumer fetch verified.',
    );
    this.code = code;
  }
}

type Launch = (args: string[]) => ChildProcess;
export async function startMuseNgrokDemo(
  options: { origin?: string; ttlMs?: number; startupMs?: number; signal?: AbortSignal } = {},
  launch: Launch = (args) =>
    spawn('/opt/homebrew/bin/ngrok', args, { stdio: ['ignore', 'pipe', 'pipe'] }),
) {
  const requestedOrigin = options.origin === undefined ? undefined : ngrokOrigin(options.origin);
  const started = Date.now();
  const ttlMs = options.ttlMs ?? TTL;
  const startupMs = options.startupMs ?? 30000;
  if (
    !Number.isInteger(ttlMs) ||
    ttlMs < 1 ||
    ttlMs > TTL ||
    !Number.isInteger(startupMs) ||
    startupMs < 1 ||
    startupMs > 30000
  )
    throw new Error('Invalid synthetic tunnel bounds.');
  const directory = await mkdtemp(join(tmpdir(), 'boopy-ngrok-demo-'));
  await chmod(directory, 0o700);
  const override = join(directory, 'override.yml');
  let gate: Awaited<ReturnType<typeof startMuseDemoGate>> | undefined;
  let demo: Awaited<ReturnType<typeof startMuseConnectorDemo>> | undefined;
  let child: ChildProcess | undefined;
  let exited: Promise<void> | undefined;
  let stopping = false;
  let accountMismatch = false;
  let stderr = '';
  let capturedBytes = 0;
  let outputExceeded = false;
  let closing: Promise<void> | undefined;
  let finish!: () => void;
  const closed = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let rejectStartup: (error: Error) => void = () => {};
  const failed = new Promise<never>((_, reject) => {
    rejectStartup = reject;
  });
  // Cleanup may reject startup before the first await installs its race handler.
  void failed.catch(() => {});
  const close = () => {
    stopping = true;
    rejectStartup(new Error('Synthetic tunnel stopped.'));
    closing ??= (async () => {
      clearTimeout(deadline);
      options.signal?.removeEventListener('abort', stop);
      await gate?.close();
      if (child && exited) {
        child.kill('SIGTERM');
        const force = setTimeout(() => child?.kill('SIGKILL'), 1000);
        await exited;
        clearTimeout(force);
      }
      if (demo) {
        checkpoint = demo.checkpoint();
        await demo.close();
      }
      await rm(directory, { recursive: true, force: true });
      finish();
    })();
    return closing;
  };
  const stop = () => {
    void close();
  };
  let checkpoint = { fullFetchDisclosures: 0, disclosures: 0, actualMuse: 'unverified' as const };
  const deadline = setTimeout(stop, Math.max(1, ttlMs - (Date.now() - started)));
  options.signal?.addEventListener('abort', stop, { once: true });
  try {
    if (options.signal?.aborted) throw new Error();
    await writeFile(
      override,
      'version: 3\nagent:\n  web_addr: false\n  remote_management: false\n',
      { mode: 0o600, flag: 'wx' },
    );
    gate = await startMuseDemoGate({ ttlMs: Math.max(1, ttlMs - (Date.now() - started)) });
    if (stopping) throw new Error();
    const gateUrl = gate.localUrl;
    const ready = new Promise<string>((resolve, reject) => {
      child = launch([
        'http',
        gateUrl,
        `--url=${requestedOrigin ?? 'https://'}`,
        '--inspect=false',
        '--log=stdout',
        '--log-format=json',
        '--config',
        join(homedir(), 'Library', 'Application Support', 'ngrok', 'ngrok.yml'),
        '--config',
        override,
      ]);
      exited = new Promise<void>((done) => {
        child?.once('close', () => {
          accountMismatch =
            !outputExceeded && /(?:^|[^A-Z0-9_])ERR_NGROK_320(?:$|[^A-Z0-9_])/.test(stderr);
          stderr = '';
          done();
          reject(new Error());
          if (!stopping) stop();
        });
        child?.once('error', () => {
          done();
          reject(new Error());
          if (!stopping) stop();
        });
      });
      let buffer = '';
      child.stderr?.on('data', (chunk: Buffer) => {
        capturedBytes += chunk.length;
        if (capturedBytes > 65536) {
          outputExceeded = true;
          stderr = '';
          reject(new Error());
          stop();
          return;
        }
        stderr += chunk.toString('utf8');
      });
      child.stdout?.on('data', (chunk: Buffer) => {
        capturedBytes += chunk.length;
        if (capturedBytes > 65536) {
          outputExceeded = true;
          reject(new Error());
          stop();
          return;
        }
        buffer += chunk.toString('utf8');
        while (buffer.includes('\n')) {
          const index = buffer.indexOf('\n');
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          try {
            const record = JSON.parse(line);
            if (record.msg === 'started tunnel' && record.url) {
              const returnedOrigin = ngrokOrigin(record.url);
              if (requestedOrigin !== undefined && returnedOrigin !== requestedOrigin) {
                reject(new Error());
                stop();
                return;
              }
              resolve(returnedOrigin);
            }
          } catch {
            /* Never relay raw vendor logs. */
          }
        }
      });
    });
    const startupTimer = setTimeout(() => rejectStartup(new Error()), Math.min(startupMs, ttlMs));
    let origin: string;
    try {
      origin = await Promise.race([ready, failed]);
    } finally {
      clearTimeout(startupTimer);
    }
    if (stopping || Date.now() >= started + ttlMs) throw new Error();
    demo = await startMuseConnectorDemo({
      origin,
      ttlMs: Math.max(1, started + ttlMs - Date.now()),
    });
    if (stopping) {
      await demo.close();
      throw new Error();
    }
    gate.activate({
      origin,
      upstreamUrl: demo.metadata.localUrl,
      packageId: demo.metadata.packageId,
    });
    return {
      metadata: {
        synthetic: true,
        origin,
        localGateUrl: gate.localUrl,
        packageId: demo.metadata.packageId,
        tokenFile: demo.metadata.tokenFile,
        expiresAt: new Date(started + ttlMs).toISOString(),
        actualMuse: 'unverified',
      },
      close,
      closed,
      checkpoint: () => ({
        ...(demo && !stopping ? demo.checkpoint() : checkpoint),
        // Aggregate gate observations are not consumer receipt or caller identity.
        gateDiagnostics: gate?.diagnostics(),
      }),
    };
  } catch {
    await gate?.close();
    await demo?.close();
    await close();
    throw new NgrokDemoError(accountMismatch ? 'account_mismatch' : 'failed');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const { values } = parseArgs({
      args: process.argv.slice(2),
      options: { origin: { type: 'string' } },
    });
    const run = await startMuseNgrokDemo({
      ...(values.origin === undefined ? {} : { origin: values.origin }),
      signal: controller.signal,
    });
    console.log(JSON.stringify(run.metadata));
    await run.closed;
    console.log(JSON.stringify({ synthetic: true, stopped: true, ...run.checkpoint() }));
  } catch (failure) {
    console.error(
      failure instanceof NgrokDemoError
        ? failure.message
        : 'Synthetic ngrok demo stopped or failed. No consumer success is claimed.',
    );
    process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}
