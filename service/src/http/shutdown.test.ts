import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { type AddressInfo, connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { FixtureInterpreter } from '../interpret/fixture.ts';
import { Journal } from '../journal.ts';
import { startRequest, testBoopy } from '../testing.ts';
import { connectorApp } from './connector.ts';
import { headsetApp } from './headset.ts';

// Raw sockets, because a stop is about what happens to a kept connection, which fetch hides.
// Deadlines make a close() that waits for fastify's 72 s keep-alive timeout fail within seconds.

const token = 'synthetic-shutdown-token';
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

async function within<T>(promise: Promise<T>, timeout: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} took over ${timeout} ms.`)), timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

interface Response {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** The final response once it is complete; interim 100 Continue responses are skipped. */
function finalResponse(bytes: Buffer): Response | undefined {
  let offset = 0;
  for (;;) {
    const end = bytes.indexOf('\r\n\r\n', offset);
    if (end === -1) return undefined;
    const [statusLine = '', ...lines] = bytes
      .subarray(offset, end)
      .toString('latin1')
      .split('\r\n');
    const status = Number(statusLine.split(' ')[1]);
    const headers = Object.fromEntries(
      lines.map((line) => {
        const colon = line.indexOf(':');
        return [line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()];
      }),
    );
    const start = end + 4;
    if (status === 100) {
      offset = start;
      continue;
    }
    if (headers['transfer-encoding'] !== 'chunked') {
      const length = Number(headers['content-length'] ?? 0);
      if (bytes.length < start + length) return undefined;
      return { status, headers, body: bytes.subarray(start, start + length).toString('utf8') };
    }
    const chunks: Buffer[] = [];
    let at = start;
    for (;;) {
      const lineEnd = bytes.indexOf('\r\n', at);
      if (lineEnd === -1) return undefined;
      const size = Number.parseInt(bytes.subarray(at, lineEnd).toString('latin1'), 16);
      if (size === 0)
        return bytes.length >= lineEnd + 4
          ? { status, headers, body: Buffer.concat(chunks).toString('utf8') }
          : undefined;
      if (bytes.length < lineEnd + 2 + size + 2) return undefined;
      chunks.push(bytes.subarray(lineEnd + 2, lineEnd + 2 + size));
      at = lineEnd + 2 + size + 2;
    }
  }
}

/** One kept HTTP/1.1 connection; only the server closes it before cleanup. */
class Wire {
  readonly closed: Promise<void>;
  #received = Buffer.alloc(0);
  readonly #socket: Socket;
  readonly #port: number;

  private constructor(socket: Socket, port: number) {
    this.#socket = socket;
    this.#port = port;
    socket.on('data', (chunk: Buffer) => {
      this.#received = Buffer.concat([this.#received, chunk]);
    });
    socket.on('error', () => {});
    this.closed = new Promise((resolve) => socket.once('close', () => resolve()));
  }

  static async open(port: number): Promise<Wire> {
    const socket = connect(port, '127.0.0.1');
    await once(socket, 'connect');
    return new Wire(socket, port);
  }

  get text(): string {
    return this.#received.toString('utf8');
  }

  get isClosed(): boolean {
    return this.#socket.destroyed;
  }

  request(method: string, path: string, headers: Readonly<Record<string, string | number>>) {
    const lines = [`${method} ${path} HTTP/1.1`, `Host: 127.0.0.1:${this.#port}`];
    for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`);
    this.#socket.write(`${lines.join('\r\n')}\r\n\r\n`);
  }

  send(bytes: Buffer): void {
    this.#socket.write(bytes);
  }

  response(timeout: number): Promise<Response> {
    return until(() => finalResponse(this.#received), timeout, 'the whole response');
  }

  destroy(): void {
    this.#socket.destroy();
  }
}

interface Served {
  readonly app: FastifyInstance;
  readonly port: number;
  readonly journal: Journal;
  readonly idle: { readonly path: string };
  /** A POST that stays in progress until its body is complete. */
  readonly busy: {
    readonly path: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: Buffer;
  };
}

async function serve(kind: 'headset' | 'connector', closeGraceMs: number): Promise<Served> {
  const { boopy, journal } = testBoopy();
  if (kind === 'headset') {
    const app = headsetApp(boopy, { logger: false, closeGraceMs });
    await app.listen({ host: '127.0.0.1', port: 0 });
    return {
      app,
      port: (app.server.address() as AddressInfo).port,
      journal,
      idle: { path: '/v1/health' },
      busy: {
        path: '/v1/sessions',
        headers: {},
        body: Buffer.from(JSON.stringify(startRequest('What is this?'))),
      },
    };
  }
  const view = await boopy.start(startRequest('Help me describe this synthetic trip.'));
  const packageId = boopy.commit(view.id).committed?.packageId;
  assert.ok(packageId);
  const app = connectorApp(boopy, {
    token,
    baseUrl: 'http://127.0.0.1',
    logger: false,
    memory: true,
    closeGraceMs,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  return {
    app,
    port: (app.server.address() as AddressInfo).port,
    journal,
    idle: { path: '/health' },
    busy: {
      path: '/v1/recall',
      headers: { authorization: `Bearer ${token}` },
      body: Buffer.from(JSON.stringify({ packageIds: [packageId], query: 'synthetic trip' })),
    },
  };
}

/** Sends the headers and half the body, and returns once the server has the request. */
async function startBusy(wire: Wire, busy: Served['busy']): Promise<Buffer> {
  wire.request('POST', busy.path, {
    ...busy.headers,
    'content-type': 'application/json',
    'content-length': busy.body.length,
    expect: '100-continue',
  });
  await until(() => wire.text.includes('HTTP/1.1 100 Continue'), 2000, 'the server to take it');
  const half = Math.floor(busy.body.length / 2);
  wire.send(busy.body.subarray(0, half));
  return busy.body.subarray(half);
}

for (const kind of ['headset', 'connector'] as const) {
  test(`${kind}: a request in progress when close begins gets its whole response, then its socket and the close end at once`, async () => {
    const served = await serve(kind, 5000);
    const wire = await Wire.open(served.port);
    try {
      const rest = await startBusy(wire, served.busy);
      const recorded = served.journal.all().length;
      const closing = served.app.close();
      await until(() => !served.app.server.listening, 2000, 'close to begin');
      wire.send(rest);
      const response = await wire.response(2000);
      assert.equal(response.status, 200);
      assert.equal(response.headers.connection, 'close');
      assert.ok(JSON.parse(response.body));
      await within(wire.closed, 1000, 'the server closing the socket after the response');
      await within(closing, 1000, 'close() after the response');
      assert.ok(served.journal.all().length > recorded, 'the request journaled before close ended');
    } finally {
      wire.destroy();
      await served.app.close();
    }
  });

  test(`${kind}: an idle keep-alive connection does not delay close`, async () => {
    const served = await serve(kind, 5000);
    const wire = await Wire.open(served.port);
    try {
      wire.request('GET', served.idle.path, {});
      const response = await wire.response(2000);
      assert.equal(response.status, 200);
      assert.equal(response.headers.connection, 'keep-alive');
      const started = performance.now();
      await within(served.app.close(), 1000, 'close() with an idle connection');
      assert.ok(performance.now() - started < 1000);
      await within(wire.closed, 1000, 'the server closing the idle socket');
    } finally {
      wire.destroy();
    }
  });

  test(`${kind}: a request that never finishes is cut at the grace`, async () => {
    const grace = 200;
    const served = await serve(kind, grace);
    const wire = await Wire.open(served.port);
    try {
      await startBusy(wire, served.busy);
      const started = performance.now();
      await within(served.app.close(), grace + 2000, 'close() with a request that never finishes');
      const elapsed = performance.now() - started;
      assert.ok(elapsed >= grace - 20, `the request had its grace (${Math.round(elapsed)} ms)`);
      await within(wire.closed, 1000, 'the cut socket closing');
      assert.equal(wire.isClosed, true);
      assert.doesNotMatch(wire.text, /HTTP\/1\.1 [2-5]\d\d/);
    } finally {
      wire.destroy();
      await served.app.close();
    }
  });
}

test('headset: a progress stream whose headers went out before close began closes its socket when it ends', async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fixture = new FixtureInterpreter();
  const { boopy } = testBoopy({
    interpreter: {
      provider: 'fixture',
      model: 'synthetic',
      async interpret(input) {
        await held;
        return fixture.interpret(input);
      },
    },
  });
  const app = headsetApp(boopy, { logger: false, closeGraceMs: 5000 });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const wire = await Wire.open((app.server.address() as AddressInfo).port);
  try {
    const body = Buffer.from(JSON.stringify(startRequest('What is this?')));
    wire.request('POST', '/v1/sessions', {
      accept: 'application/x-ndjson',
      'content-type': 'application/json',
      'content-length': body.length,
    });
    wire.send(body);
    await until(() => wire.text.includes('"interpreting"'), 2000, 'the interpreting stage');
    assert.match(wire.text, /\r\nConnection: keep-alive\r\n/i);
    const closing = app.close();
    await until(() => !app.server.listening, 2000, 'close to begin');
    release();
    const response = await wire.response(2000);
    const events = response.body
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(events.at(-1).type, 'result');
    await within(wire.closed, 1000, 'the server closing the socket after the stream');
    await within(closing, 1000, 'close() after the stream');
  } finally {
    release();
    wire.destroy();
    await app.close();
  }
});

// The stop exits right after the servers close; this is why no journal append can be cut then.
test('a journal append is committed to its file before append() returns', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'boopy-synthetic-journal-'));
  const path = join(directory, 'journal.sqlite');
  const writer = Journal.open(path);
  const reader = Journal.open(path);
  try {
    writer.append(
      {
        type: 'context.disclosed',
        session: 'ses_synthetic',
        actor: 'agent:synthetic',
        data: { packageId: 'pkg_synthetic', agent: 'synthetic', via: 'rest', tool: 'get' },
      },
      'evt_synthetic',
      '1970-01-01T12:00:00.000Z',
    );
    // No await in between: another connection to the file already reads the committed row.
    assert.deepEqual(
      reader.all().map((event) => event.id),
      ['evt_synthetic'],
    );
  } finally {
    writer.close();
    reader.close();
    await rm(directory, { recursive: true, force: true });
  }
});
