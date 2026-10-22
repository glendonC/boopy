import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { type AddressInfo, connect, createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Journal } from './journal.ts';

test('failed optional local providers preserve core startup and honest capabilities', {
  timeout: 20000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'boopy-synthetic-startup-'));
  const reservations = [createServer(), createServer()];
  await Promise.all(
    reservations.map(
      (server) => new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)),
    ),
  );
  const ports = reservations.map((server) => (server.address() as AddressInfo).port);
  await Promise.all(
    reservations.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  const child = spawn(process.execPath, [fileURLToPath(new URL('./main.ts', import.meta.url))], {
    env: {
      PATH: '/usr/bin:/bin',
      BOOPY_DATA_DIR: directory,
      BOOPY_PORT: String(ports[0]),
      BOOPY_CONNECTOR_PORT: String(ports[1]),
      BOOPY_INTERPRETER: 'fixture',
      BOOPY_LOG: '0',
      BOOPY_SPEECH_OUTPUT: 'qwen',
      BOOPY_VOICE_PYTHON: '/synthetic-private-missing/python',
      BOOPY_VOICE_MODEL: '/synthetic-private-missing/voice',
      BOOPY_LIVE_SCENE: 'local',
      BOOPY_SCENE_PYTHON: '/synthetic-private-missing/python',
      BOOPY_SCENE_DETECTOR: '/synthetic-private-missing/detector',
      BOOPY_SCENE_SEGMENTER: '/synthetic-private-missing/segmenter',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Synthetic service startup deadline.')),
        10000,
      );
      child.once('error', reject);
      child.once('close', () => {
        clearTimeout(timer);
        reject(new Error('Synthetic service exited before readiness.'));
      });
      child.stdout.on('data', (data: Buffer) => {
        output += data.toString();
        if (output.includes('headset API')) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.stderr.on('data', (data: Buffer) => {
        output += data.toString();
      });
    });
    const base = `http://127.0.0.1:${ports[0]}`;
    const health = await (await fetch(`${base}/v1/health`)).json();
    assert.equal(health.service, 'boopy');
    assert.equal(health.ok, true);
    assert.equal(health.speechOutputAvailable, false);
    assert.equal(health.liveScene, null);
    assert.equal(health.handoffPreparationAvailable, true);
    const scene = await fetch(`${base}/v1/scene/observe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(scene.status, 503);
    const authored = await fetch(`${base}/v1/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        cues: {},
        speech: { text: 'For this fictional example I walked before noon.' },
        attention: { scope: 'scene', evidence: 'none', source: 'unknown' },
        device: { model: 'synthetic', app: 'startup-test' },
      }),
    });
    assert.equal(authored.status, 200);
    const view = await authored.json();
    assert.ok(view.items.some((item: { origin: string }) => item.origin === 'person'));
    assert.equal(view.model, null);
    assert.doesNotMatch(output, /synthetic-private-missing|ENOENT|Traceback/);
  } finally {
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
    await closed;
    clearTimeout(timer);
    await rm(directory, { recursive: true, force: true });
  }
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(read: () => T | undefined | false, timeout: number, what: string) {
  const deadline = performance.now() + timeout;
  for (;;) {
    const value = read();
    if (value) return value;
    if (performance.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await sleep(5);
  }
}

/** A complete response with a declared length, after any interim 100 Continue. */
function finalResponse(text: string) {
  const start = text.lastIndexOf('HTTP/1.1 ');
  const end = text.indexOf('\r\n\r\n', start);
  if (start === -1 || end === -1 || text.startsWith('HTTP/1.1 100 ', start)) return undefined;
  const [statusLine = '', ...lines] = text.slice(start, end).split('\r\n');
  const headers: Record<string, string> = Object.fromEntries(
    lines.map((line) => {
      const colon = line.indexOf(':');
      return [line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()];
    }),
  );
  const body = Buffer.from(text.slice(end + 4));
  if (!(body.length >= Number(headers['content-length']))) return undefined;
  return { status: Number(statusLine.split(' ')[1]), headers, body: body.toString() };
}

test('a stop lets the request in progress finish, ignores further signals and exits right after', {
  timeout: 30000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'boopy-synthetic-stop-'));
  const reservations = [createServer(), createServer()];
  await Promise.all(
    reservations.map(
      (server) => new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)),
    ),
  );
  const [port = 0, connectorPort = 0] = reservations.map(
    (server) => (server.address() as AddressInfo).port,
  );
  await Promise.all(
    reservations.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  const child = spawn(process.execPath, [fileURLToPath(new URL('./main.ts', import.meta.url))], {
    env: {
      PATH: '/usr/bin:/bin',
      BOOPY_DATA_DIR: directory,
      BOOPY_PORT: String(port),
      BOOPY_CONNECTOR_PORT: String(connectorPort),
      BOOPY_INTERPRETER: 'fixture',
      BOOPY_LOG: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (data: Buffer) => {
    output += data.toString();
  });
  child.stderr.on('data', (data: Buffer) => {
    output += data.toString();
  });
  let exit: { code: number | null } | undefined;
  child.once('exit', (code) => {
    exit = { code };
  });
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  let socket: Socket | undefined;
  try {
    await until(() => output.includes('headset API') || exit, 10000, 'the service to start');
    assert.match(output, /headset API/);
    socket = connect(port, '127.0.0.1');
    socket.on('error', () => {});
    await once(socket, 'connect');
    let received = '';
    socket.on('data', (data: Buffer) => {
      received += data.toString();
    });
    const body = Buffer.from(
      JSON.stringify({
        cues: {},
        speech: { text: 'For this fictional example I walked before noon.' },
        attention: { scope: 'scene', evidence: 'none', source: 'unknown' },
        device: { model: 'synthetic', app: 'stop-test' },
      }),
    );
    socket.write(
      [
        'POST /v1/sessions HTTP/1.1',
        `Host: 127.0.0.1:${port}`,
        'Content-Type: application/json',
        `Content-Length: ${body.length}`,
        'Expect: 100-continue',
        '',
        '',
      ].join('\r\n'),
    );
    await until(() => received.includes('HTTP/1.1 100 Continue'), 5000, 'the request to start');
    socket.write(body.subarray(0, 20));
    child.kill('SIGTERM');
    await until(() => output.includes('Stopping'), 5000, 'the stop to begin');
    child.kill('SIGTERM');
    child.kill('SIGINT');
    await sleep(300);
    assert.equal(child.exitCode, null, 'a further signal must not end the stop early');
    socket.write(body.subarray(20));
    const response = await until(() => finalResponse(received), 5000, 'the whole response');
    assert.equal(response.status, 200);
    assert.equal(response.headers.connection, 'close');
    const view = JSON.parse(response.body);
    const exited = await until(() => exit, 3000, 'the exit after the response');
    assert.equal(exited.code, 0);
    assert.equal(output.match(/Stopping/g)?.length, 1, output);
    assert.doesNotMatch(output, /Error|ERR_/);
    const journal = Journal.open(join(directory, 'journal.sqlite'));
    try {
      assert.ok(journal.all().some((event) => event.session === view.id));
    } finally {
      journal.close();
    }
  } finally {
    socket?.destroy();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
    await rm(directory, { recursive: true, force: true });
  }
});
