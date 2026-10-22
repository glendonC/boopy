/**
 * Adversarial checks of U13b: `pnpm activity export` claims its known file name before asking the
 * service, removes only a file it created and could not fill, never touches an existing file or
 * link, and lets exactly one of two concurrent exports write.
 */
import assert from 'node:assert/strict';
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ActivityStore } from '../activity.ts';
import { exportSubmission } from '../cli/activity.ts';
import { HandoffPreparation } from '../handoff-preparation.ts';
import { connectorApp } from '../http/connector.ts';
import { startRequest, testBoopy } from '../testing.ts';

const TOKEN = 'synthetic-audit-claim-token';

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'boopy-audit-claim-'));
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
  const exportCalls: string[] = [];
  app.addHook('onRequest', async (request) => {
    if (request.url.includes('/export')) exportCalls.push(request.url);
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  port = (app.server.address() as AddressInfo).port;
  await preparation.prepare(session.id, { requestId: 'audit-preparation-1', packageId });
  const request = await store.prepareRequest({ packageId, goal: 'Synthetic goal.' });
  const { activityId } = store.importActivity(
    JSON.stringify({
      type: 'boopy.activity',
      version: 1,
      binding: JSON.parse(request.file).respondWith.binding,
      fallbackText: 'Synthetic fallback.',
      activity: {
        title: 'Camel and tent',
        purpose: 'Synthetic practice.',
        instruction: { text: 'Place them.', language: 'en' },
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
      },
    }),
  );
  store.arrange(activityId, { revision: 0, positions: { a: 0.2, b: 0.7 } });
  const submissionId = store.submit(activityId, { revision: 1 }).submissions[0]?.submissionId;
  assert.ok(submissionId);
  const exports = () =>
    test.journal.all().filter((event) => event.type === 'activity.submission-exported').length;
  return {
    directory,
    out,
    store,
    activityId,
    submissionId,
    name: `boopy-activity-submission-${submissionId}.json`,
    exportCalls,
    exports,
    run: (outDir: string, id = submissionId) =>
      exportSubmission({ dataDir, port, submissionId: id, outDir }),
    async close() {
      app.server.closeAllConnections();
      await app.close();
      test.journal.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('audit U13b: a refused export leaves no claimed file and journals nothing', async () => {
  const t = await setup();
  try {
    await assert.rejects(
      t.run(t.out, 'sub_unknownaudit'),
      /refused this \(404 submission_unknown\)/,
    );
    assert.equal(t.exportCalls.length, 1);
    assert.deepEqual(await readdir(t.out), []);
    assert.equal(t.exports(), 0);
  } finally {
    await t.close();
  }
});

test('audit U13b: a link or file at the export name is refused before the service is asked', async () => {
  const t = await setup();
  try {
    const target = join(t.directory, 'outside.json');
    await writeFile(target, 'synthetic outside file');
    for (const [kind, make] of [
      ['dangling link', () => symlink(join(t.directory, 'nowhere.json'), join(t.out, t.name))],
      ['link to a file', () => symlink(target, join(t.out, t.name))],
      ['empty file', () => writeFile(join(t.out, t.name), '')],
    ] as const) {
      await make();
      await assert.rejects(t.run(t.out), /never overwritten\. Nothing was requested\./, kind);
      assert.equal(t.exportCalls.length, 0, `${kind} reached the service`);
      assert.equal(t.exports(), 0, kind);
      const info = await lstat(join(t.out, t.name));
      if (kind === 'empty file') assert.equal(info.size, 0);
      else assert.ok(info.isSymbolicLink(), `${kind} was removed or replaced`);
      if (kind === 'link to a file') assert.equal(await readlink(join(t.out, t.name)), target);
      await rm(join(t.out, t.name));
    }
    assert.equal(await readFile(target, 'utf8'), 'synthetic outside file');
    assert.deepEqual(await readdir(t.out), []);
  } finally {
    await t.close();
  }
});

test('audit U13b: of two concurrent exports exactly one writes, and a retry repeats the record', async () => {
  const t = await setup();
  try {
    const results = await Promise.allSettled([t.run(t.out), t.run(t.out)]);
    const written = results.filter((result) => result.status === 'fulfilled');
    assert.equal(written.length, 1);
    assert.equal(t.exportCalls.length, 1, 'the losing export still asked the service');
    assert.equal(t.exports(), 1);
    const first = written[0];
    assert.ok(first?.status === 'fulfilled');
    const bytes = await readFile(join(t.out, t.name), 'utf8');
    assert.equal(
      first.value.fileSha256,
      t.store.view(t.activityId).submissions[0]?.export?.fileSha256,
    );
    const fresh = join(t.directory, 'fresh');
    await mkdir(fresh, { mode: 0o700 });
    const again = await t.run(fresh);
    assert.equal(again.fileSha256, first.value.fileSha256);
    assert.equal(await readFile(join(fresh, t.name), 'utf8'), bytes);
    assert.equal(t.exports(), 1, 'a repeat into another folder journaled a new export');
  } finally {
    await t.close();
  }
});
