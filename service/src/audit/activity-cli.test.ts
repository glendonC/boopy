/** Adversarial checks of `pnpm activity` (U5, audit case A9): files, refusals and printing. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ActivityStore } from '../activity.ts';
import { sha256 } from '../activity-contract.ts';
import { exportSubmission, importActivity, importReply, requestActivity } from '../cli/activity.ts';
import { HandoffPreparation } from '../handoff-preparation.ts';
import { connectorApp } from '../http/connector.ts';
import { startRequest, testBoopy } from '../testing.ts';

const TOKEN = 'synthetic-audit-cli-token';
const GOAL = 'Synthetic goal marker 6021';

/** A real connector with the activity routes; every request that reaches it is counted. */
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'boopy-audit-cli-'));
  const dataDir = join(directory, 'data');
  const out = join(directory, 'out');
  await mkdir(dataDir, { mode: 0o700 });
  await mkdir(out, { mode: 0o700 });
  await writeFile(join(dataDir, 'connector-token'), TOKEN, { mode: 0o600 });
  const test = testBoopy();
  const session = await test.boopy.start(startRequest('Synthetic camel and tent.'));
  const packageId = test.boopy.commit(session.id).committed?.packageId;
  assert.ok(packageId);
  let port = 0;
  const preparation = new HandoffPreparation({
    journal: test.journal,
    outputRoot: join(dataDir, 'handoffs'),
    dataDir,
    get port() {
      return port;
    },
    packageForId: (id) => test.boopy.package(id),
    sessionForId: (id) => test.boopy.view(id),
    supersessions: () => test.boopy.supersessions,
  });
  const store = new ActivityStore({
    journal: test.journal,
    preparation,
    packageForId: (id) => test.boopy.package(id),
    supersessions: () => test.boopy.supersessions,
  });
  const app = connectorApp(test.boopy, {
    token: TOKEN,
    baseUrl: 'http://127.0.0.1',
    logger: false,
    handoff: preparation,
    activities: store,
  });
  const seen: string[] = [];
  app.addHook('onRequest', async (request) => {
    if (request.url.startsWith('/v1/local-activities')) seen.push(request.url);
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  port = (app.server.address() as AddressInfo).port;
  await preparation.prepare(session.id, { requestId: 'synthetic-preparation-1', packageId });
  return {
    directory,
    dataDir,
    out,
    packageId,
    store,
    port,
    seen,
    events: () => test.journal.all().length,
    async close() {
      app.server.closeAllConnections();
      await app.close();
      test.journal.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
type Setup = Awaited<ReturnType<typeof setup>>;

function body() {
  return {
    title: 'Camel and tent',
    purpose: 'Synthetic practice.',
    instruction: { text: 'Put the camel left of the tent.', language: 'en' },
    components: [
      {
        type: 'arrange',
        axis: { kind: 'viewer-left-right' },
        tokens: [
          { key: 'a', label: { text: 'camel', language: 'en' }, sourceId: null },
          { key: 'b', label: { text: 'tent', language: 'en' }, sourceId: null },
        ],
      },
    ],
  };
}

async function requested(t: Setup) {
  const result = await requestActivity({
    dataDir: t.dataDir,
    port: t.port,
    packageId: t.packageId,
    goal: GOAL,
    outDir: t.out,
  });
  const file = await readFile(join(t.out, result.fileName), 'utf8');
  return { result, file, parsed: JSON.parse(file) };
}

function activityFile(binding: unknown) {
  return JSON.stringify({
    type: 'boopy.activity',
    version: 1,
    binding,
    author: 'Synthetic Assistant',
    fallbackText: 'Picture the camel to the left of the tent.',
    activity: body(),
  });
}

/** A refusal that reached neither the service nor the journal, and left no file behind. */
async function refusedEarly(t: Setup, action: () => Promise<unknown>, label: string) {
  const seen = t.seen.length;
  const events = t.events();
  const files = await readdir(t.out);
  await assert.rejects(action, Error, label);
  assert.equal(t.seen.length, seen, `${label} reached the service`);
  assert.equal(t.events(), events, `${label} journaled`);
  assert.deepEqual(await readdir(t.out), files, `${label} left a file`);
}

test('audit U5: unusable folders, IDs and inputs are refused before the service is asked', async () => {
  const t = await setup();
  try {
    const file = join(t.directory, 'a-file.json');
    await writeFile(file, '{}');
    const fileLink = join(t.directory, 'file-link');
    await symlink(file, fileLink);
    for (const outDir of [join(t.directory, 'missing'), file, fileLink, '', '   '])
      await refusedEarly(
        t,
        () =>
          requestActivity({
            dataDir: t.dataDir,
            port: t.port,
            packageId: t.packageId,
            goal: GOAL,
            outDir,
          }),
        `out-dir ${outDir}`,
      );
    for (const packageId of ['ctx_x/../y', 'CTX_x', `ctx_${'a'.repeat(129)}`, 'ctx_a\u{0}'])
      await refusedEarly(
        t,
        () =>
          requestActivity({
            dataDir: t.dataDir,
            port: t.port,
            packageId,
            goal: GOAL,
            outDir: t.out,
          }),
        `package ${packageId}`,
      );
    for (const submissionId of [
      'sub_x/../../evil',
      '../sub_x',
      'sub_x%2Fy',
      `sub_${'x'.repeat(65)}`,
      'sub_a\u{0}',
      'sub_',
    ])
      await refusedEarly(
        t,
        () => exportSubmission({ dataDir: t.dataDir, port: t.port, submissionId, outDir: t.out }),
        `submission ${submissionId}`,
      );
    const { parsed } = await requested(t);
    const valid = join(t.directory, 'valid.json');
    await writeFile(valid, activityFile(parsed.respondWith.binding));
    const linked = join(t.directory, 'linked.json');
    await symlink(valid, linked);
    const fifo = join(t.directory, 'fifo.json');
    execFileSync('mkfifo', [fifo]);
    const folder = join(t.directory, 'folder.json');
    await mkdir(folder);
    const large = join(t.directory, 'large.json');
    await writeFile(large, `${activityFile(parsed.respondWith.binding)}${' '.repeat(70_000)}`);
    const binary = join(t.directory, 'binary.json');
    await writeFile(binary, Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x7d]));
    for (const input of [
      linked,
      fifo,
      '/dev/zero',
      folder,
      large,
      binary,
      join(t.directory, 'none'),
    ])
      for (const run of [importActivity, importReply])
        await refusedEarly(
          t,
          () => run({ dataDir: t.dataDir, port: t.port, file: input }),
          `${run.name} ${input}`,
        );
  } finally {
    await t.close();
  }
});

test('audit U5: written files are new, private and complete, and printing stays plain', async () => {
  const t = await setup();
  const previous = process.umask(0);
  try {
    const { result, file, parsed } = await requested(t);
    assert.equal((await stat(join(t.out, result.fileName))).mode & 0o777, 0o600);
    assert.equal(sha256(file), result.fileSha256);
    assert.deepEqual(await readdir(t.out), [result.fileName]);
    for (const secret of [
      TOKEN,
      t.directory,
      t.dataDir,
      t.out,
      GOAL,
      parsed.context.packet.slice(0, 60),
    ])
      assert.equal(result.message.includes(secret), false, secret);
    const bom = join(t.directory, 'bom.json');
    const bytes = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(activityFile(parsed.respondWith.binding)),
    ]);
    await writeFile(bom, bytes);
    const imported = await importActivity({ dataDir: t.dataDir, port: t.port, file: bom });
    assert.equal(imported.status, 'active');
    assert.equal(t.store.view(imported.activityId).provenance.artifactSha256, sha256(bytes));
    const exact = join(t.directory, 'exact.json');
    const text = activityFile(parsed.respondWith.binding).replace(
      'Camel and tent',
      'Tent and camel',
    );
    await writeFile(exact, `${text}${' '.repeat(64 * 1024 - Buffer.byteLength(text))}`);
    const accepted = await importActivity({ dataDir: t.dataDir, port: t.port, file: exact });
    assert.equal(accepted.status, 'active');
    const activityId = imported.activityId;
    t.store.arrange(activityId, { revision: 0, positions: { a: 0.2, b: 0.7 } });
    const submissionId = t.store.submit(activityId, { revision: 1 }).submissions[0]?.submissionId;
    assert.ok(submissionId);
    const exported = await exportSubmission({
      dataDir: t.dataDir,
      port: t.port,
      submissionId,
      outDir: t.out,
    });
    const path = join(t.out, exported.fileName);
    const first = await readFile(path, 'utf8');
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    await assert.rejects(
      exportSubmission({ dataDir: t.dataDir, port: t.port, submissionId, outDir: t.out }),
    );
    assert.equal(await readFile(path, 'utf8'), first);
    assert.deepEqual((await readdir(t.out)).sort(), [exported.fileName, result.fileName].sort());
  } finally {
    process.umask(previous);
    await t.close();
  }
});

test('audit U5: hostile connector answers never write a file and print only plain text', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'boopy-audit-cli-fake-'));
  const dataDir = join(directory, 'data');
  const out = join(directory, 'out');
  await mkdir(dataDir, { mode: 0o700 });
  await mkdir(out, { mode: 0o700 });
  await writeFile(join(dataDir, 'connector-token'), TOKEN, { mode: 0o600 });
  let answer: { status: number; body: string; location?: string } = { status: 200, body: '{}' };
  const hits: string[] = [];
  const server = createServer(async (incoming, outgoing) => {
    for await (const _chunk of incoming) {
      /* drain */
    }
    hits.push(incoming.url ?? '');
    outgoing.writeHead(answer.status, {
      'content-type': 'application/json',
      ...(answer.location ? { location: answer.location } : {}),
    });
    outgoing.end(answer.body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const request = () =>
    requestActivity({ dataDir, port, packageId: 'ctx_synthetic1', goal: GOAL, outDir: out });
  try {
    const file = '{"type":"boopy.activity-request"}\n';
    for (const reply of [
      { fileName: '../escaped.json', fileSha256: sha256(file), file, requestId: 'arq_x' },
      {
        fileName: 'boopy-activity-request-arq_x.json',
        fileSha256: '0'.repeat(64),
        file,
        requestId: 'arq_x',
      },
      {
        fileName: 'boopy-activity-request-arq_y.json',
        fileSha256: sha256(file),
        file,
        requestId: 'arq_x',
      },
      { fileName: 'x.json', fileSha256: sha256(file), file, requestId: 'arq_../x' },
    ]) {
      answer = { status: 200, body: JSON.stringify(reply) };
      await assert.rejects(request());
      assert.deepEqual(await readdir(out), []);
      assert.deepEqual(await readdir(directory), ['data', 'out']);
    }
    answer = {
      status: 400,
      body: JSON.stringify({
        error: {
          code: 'Activity Invalid\u{202e}',
          message: `bad\u{1b}[31m\u{202e}\u{200b}${'x'.repeat(500)}`,
          issues: ['a\u{0}b', 'c\u{2066}d', 'e\nf'],
        },
      }),
    };
    const failure = await request().then(
      () => null,
      (error: Error) => error.message,
    );
    assert.ok(failure);
    assert.match(failure, /^Boopy refused this \(400 refused\)/);
    for (const line of failure.split('\n')) {
      assert.doesNotMatch(line, /\p{C}/u, JSON.stringify(line));
      assert.ok(line.length <= 340, String(line.length));
    }
    const target = createServer((_incoming, outgoing) => {
      hits.push('target');
      outgoing.end('{}');
    });
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
    try {
      answer = {
        status: 307,
        body: '',
        location: `http://127.0.0.1:${(target.address() as AddressInfo).port}/v1/local-activities/requests`,
      };
      await assert.rejects(request());
      assert.equal(hits.includes('target'), false);
      assert.deepEqual(await readdir(out), []);
    } finally {
      target.closeAllConnections();
      await new Promise<void>((resolve) => target.close(() => resolve()));
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
