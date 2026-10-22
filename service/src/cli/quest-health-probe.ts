/** USB boot/connectivity diagnostic. Accepts health reads only; never accepts wearer media. */
import type { AddressInfo } from 'node:net';
import { pathToFileURL } from 'node:url';
import { Boopy } from '../boopy.ts';
import { headsetApp } from '../http/headset.ts';
import { FixtureInterpreter } from '../interpret/fixture.ts';
import { Journal, MediaStore } from '../journal.ts';

const MAX_TTL_MS = 15 * 60 * 1000;

export async function createQuestHealthProbe(options: { port?: number; ttlMs?: number } = {}) {
  const port = options.port ?? 47900;
  const ttlMs = options.ttlMs ?? MAX_TTL_MS;
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error('Probe port must be an integer from 0 to 65535.');
  if (!Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_TTL_MS)
    throw new Error('Probe TTL must be positive and at most 15 minutes.');
  const journal = Journal.open(':memory:');
  let mediaWrites = 0;
  const media = new (class extends MediaStore {
    override put(bytes: Buffer, extension: 'jpg' | 'wav' | 'mask'): string {
      mediaWrites++;
      return super.put(bytes, extension);
    }
  })(null);
  const boopy = new Boopy({
    journal,
    media,
    interpreter: new FixtureInterpreter(),
    speech: null,
    text: null,
    segmenter: null,
    service: 'boopy-quest-health-probe',
  });
  const app = headsetApp(boopy, { logger: false });
  let healthReads = 0;
  let deniedRequests = 0;
  let journalEvents = 0;
  let finished = false;
  app.addHook('onRequest', async (request, reply) => {
    // Raw exact-path check also excludes query strings and encoded aliases. This hook runs
    // before parsing any body, including an invalid or oversized capture upload.
    const length = request.headers['content-length'];
    const hasBody =
      request.headers['transfer-encoding'] !== undefined ||
      (length !== undefined && !/^0+$/.test(length));
    if (request.method === 'GET' && request.raw.url === '/v1/health' && !hasBody) {
      healthReads++;
      reply.header('Cache-Control', 'no-store');
      return;
    }
    deniedRequests++;
    await reply.code(403).send({
      error: { code: 'diagnostic_only', message: 'This diagnostic accepts health checks only.' },
    });
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closing: Promise<void> | undefined;
  let resolveClosed: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const checkpoint = () => ({
    mode: 'synthetic-health-only' as const,
    loopbackOnly: true,
    healthReads,
    deniedRequests,
    journalEvents: finished ? journalEvents : journal.all().length,
    mediaWrites,
    actualWearerCapture: 'unverified' as const,
  });
  const close = () => {
    closing ??= (async () => {
      if (timer !== undefined) clearTimeout(timer);
      journalEvents = journal.all().length;
      try {
        app.server.closeAllConnections();
        await app.close();
      } finally {
        journal.close();
        finished = true;
        resolveClosed();
      }
    })();
    return closing;
  };
  try {
    await app.listen({ host: '127.0.0.1', port });
    const actualPort = (app.server.address() as AddressInfo).port;
    timer = setTimeout(() => {
      void close().catch(() => {});
    }, ttlMs);
    return {
      app,
      origin: `http://127.0.0.1:${actualPort}`,
      expiresAt: new Date(Date.now() + ttlMs).toISOString(),
      checkpoint,
      close,
      closed,
    };
  } catch (failure) {
    await close();
    throw failure;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const probe = await createQuestHealthProbe();
    console.log(
      JSON.stringify({ ...probe.checkpoint(), origin: probe.origin, expiresAt: probe.expiresAt }),
    );
    const stop = () => {
      void probe.close().catch(() => {});
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    await probe.closed;
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    console.log(JSON.stringify(probe.checkpoint()));
  } catch {
    console.error('Quest health diagnostic could not start or close. No capture was accepted.');
    process.exitCode = 1;
  }
}
