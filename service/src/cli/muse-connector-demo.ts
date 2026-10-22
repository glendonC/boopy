/** Disposable synthetic connector. Never loads production config or starts the headset API. */
import { randomBytes } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { connectorApp } from '../http/connector.ts';
import { startRequest, testBoopy } from '../testing.ts';

export function demoOrigin(value?: string): string {
  if (value === undefined) return 'http://127.0.0.1';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Demo origin must be an HTTPS origin.');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error(
      'Demo origin must be an HTTPS origin without credentials, path, query or fragment.',
    );
  return url.origin;
}

export async function startMuseConnectorDemo(options: { origin?: string; ttlMs?: number } = {}) {
  const origin = demoOrigin(options.origin);
  const ttlMs = options.ttlMs ?? 15 * 60 * 1000;
  if (!Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > 30 * 60 * 1000)
    throw new Error('Demo TTL must be positive and at most 30 minutes.');
  const directory = await mkdtemp(join(tmpdir(), 'boopy-muse-demo-'));
  await chmod(directory, 0o700);
  const tokenFile = join(directory, 'connector-token');
  const token = randomBytes(32).toString('hex');
  const marker = `synthetic-boopy-${randomBytes(8).toString('hex')}`;
  const { boopy, journal } = testBoopy();
  const connectorOptions = { token, baseUrl: origin, logger: false, memory: false };
  const app = connectorApp(boopy, connectorOptions);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closing: Promise<void> | undefined;
  let finish: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const close = () => {
    closing ??= (async () => {
      if (timer !== undefined) clearTimeout(timer);
      try {
        // A disposable demo must stop even if a client leaves a streaming connection open.
        app.server.closeAllConnections();
        await app.close();
      } finally {
        journal.close();
        try {
          await rm(directory, { recursive: true, force: true });
        } finally {
          finish();
        }
      }
    })();
    return closing;
  };
  try {
    await writeFile(tokenFile, token, { mode: 0o600, flag: 'wx' });
    const initial = await boopy.start(
      startRequest(`Synthetic fetch validation marker ${marker}. Describe this trip.`),
    );
    const item = (label: string) => {
      const found = initial.items.find((candidate) => candidate.label === label);
      if (!found) throw new Error('Synthetic fixture is missing a required category.');
      return found.id;
    };
    boopy.act(initial.id, { itemId: item('Desert photo'), action: 'confirm' });
    boopy.act(initial.id, { itemId: item('Past tense'), action: 'known' });
    await boopy.utter(initial.id, {
      speech: { text: 'Wrong because this synthetic claim is unsupported.' },
      cues: { targetItemId: item('Tents') },
    });
    await boopy.utter(initial.id, {
      speech: { text: 'Rename this to synthetic caravan' },
      cues: { targetItemId: item('Camels') },
    });
    await boopy.utter(initial.id, { speech: { text: `Also ${marker}` } });
    const saved = boopy.commit(initial.id);
    const packageId = saved.committed?.packageId;
    if (!packageId) throw new Error('Synthetic package was not committed.');
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as AddressInfo).port;
    const localUrl = `http://127.0.0.1:${port}`;
    if (options.origin === undefined) connectorOptions.baseUrl = localUrl;
    const metadata = {
      synthetic: true,
      loopbackOnly: true,
      connectorOnly: true,
      localUrl,
      publishedOrigin: connectorOptions.baseUrl,
      packageId,
      marker,
      tokenFile,
      expiresAt: new Date(Date.now() + ttlMs).toISOString(),
      actualMuse: 'unverified',
      scheduling: 'unverified',
      mediaDelivery: 'unverified',
    } as const;
    timer = setTimeout(() => {
      void close().catch(() => {});
    }, ttlMs);
    return {
      metadata,
      close,
      closed,
      checkpoint: () => ({
        fullFetchDisclosures: boopy.disclosures.filter(
          (event) => event.tool === 'get' || event.tool === 'fetch',
        ).length,
        disclosures: boopy.disclosures.length,
        actualMuse: 'unverified' as const,
      }),
    };
  } catch (error) {
    await close();
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const origin = process.argv[2];
  const ttlMs = process.argv[3] === undefined ? undefined : Number(process.argv[3]);
  try {
    const demo = await startMuseConnectorDemo({ origin, ttlMs });
    const stop = () => {
      void demo.close().catch(() => {
        process.exitCode = 1;
      });
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    console.log(JSON.stringify(demo.metadata));
    await demo.closed;
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    console.log(JSON.stringify({ synthetic: true, stopped: true, ...demo.checkpoint() }));
  } catch {
    console.error('Disposable synthetic connector failed. No consumer fetch was verified.');
    process.exitCode = 1;
  }
}
