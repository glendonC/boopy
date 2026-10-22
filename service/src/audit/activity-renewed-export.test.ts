/**
 * Adversarial checks of U13: hints opened since the previous submission stay derived (no new
 * event field), a renewed export states its own time, and a re-export the command cannot write
 * never leaves a journal entry claiming bytes the person was never given.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ActivityStore } from '../activity.ts';
import { sha256 } from '../activity-contract.ts';
import { exportSubmission } from '../cli/activity.ts';
import { HandoffPreparation } from '../handoff-preparation.ts';
import { connectorApp } from '../http/connector.ts';
import { Journal } from '../journal.ts';
import { startRequest, testBoopy } from '../testing.ts';

const TOKEN = 'synthetic-audit-renewal-token';

function body(hints = 2) {
  return {
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
    hints: Array.from({ length: hints }, (_, i) => ({ text: `Hint ${i + 1}.`, language: 'en' })),
  };
}

/** A store with one recorded request, built from a fake preparation over synthetic data. */
async function storeWithRequest(journal: Journal) {
  const packet = 'Synthetic packet.';
  const store = new ActivityStore({
    journal,
    preparation: {
      forPackage: () =>
        ({
          sessionId: 'session_audit',
          requestId: 'audit-preparation-1',
          receiptId: 'receipt_audit',
          sourceState: 'unchanged',
          receipt: { packetSha256: sha256(packet) },
        }) as unknown as ReturnType<HandoffPreparation['forPackage']>,
      readPacket: async () => packet,
    },
    packageForId: () => ({ sessionId: 'session_audit', version: 1 }) as never,
    supersessions: () => [],
  });
  const request = await store.prepareRequest({ packageId: 'ctx_audit1', goal: 'Synthetic goal.' });
  return { store, binding: JSON.parse(request.file).respondWith.binding };
}

const activityFile = (binding: unknown, activity: unknown = body()) =>
  JSON.stringify({
    type: 'boopy.activity',
    version: 1,
    binding,
    fallbackText: 'Synthetic fallback.',
    activity,
  });

test('audit U13 guard: hints since the previous submission are derived, never a new event field', async () => {
  const journal = Journal.open(':memory:');
  try {
    const { store, binding } = await storeWithRequest(journal);
    const { activityId } = store.importActivity(activityFile(binding));
    store.arrange(activityId, { revision: 0, positions: { a: 0.2, b: 0.7 } });
    store.revealHint(activityId, { revision: 1 });
    store.submit(activityId, { revision: 2 });
    store.revealHint(activityId, { revision: 3 });
    store.submit(activityId, { revision: 4 });
    const view = store.submit(activityId, { revision: 5 });
    for (const event of journal.all().filter((entry) => entry.type === 'activity.submitted'))
      assert.deepEqual(Object.keys(event.data).sort(), [
        'activityId',
        'chosen',
        'derived',
        'digest',
        'hintsRevealed',
        'positions',
        'revision',
        'submissionId',
        'text',
      ]);
    assert.deepEqual(
      view.submissions.map((entry) => entry.hintsRevealedSincePrevious),
      [[0], [1], []],
    );
    for (const entry of view.submissions) {
      const file = JSON.parse(store.exportSubmission(entry.submissionId).file);
      assert.deepEqual(
        file.submission.hintsRevealedSincePrevious,
        entry.hintsRevealedSincePrevious,
      );
      assert.deepEqual(
        file.submission.hintsRevealed.map((hint: { index: number }) => hint.index),
        entry.hintsRevealed,
      );
    }
    assert.deepEqual(new ActivityStore({ journal }).view(activityId), store.view(activityId));
  } finally {
    journal.close();
  }
});

test('audit U13 guard: a renewed export states its own time and leaves the earlier one intact', async () => {
  const journal = Journal.open(':memory:');
  try {
    const { store, binding } = await storeWithRequest(journal);
    const { activityId } = store.importActivity(activityFile(binding));
    store.arrange(activityId, { revision: 0, positions: { a: 0.2, b: 0.7 } });
    const submissionId = store.submit(activityId, { revision: 1 }).submissions[0]?.submissionId;
    assert.ok(submissionId);
    const older = {
      type: 'activity.submission-exported' as const,
      session: 'session_audit',
      actor: 'person' as const,
      data: { submissionId, activityId, fileSha256: 'a'.repeat(64), delivery: 'not-sent' as const },
    };
    journal.append(older, 'evt_audit_older_export', '1970-01-01T08:00:00.000Z');
    const restarted = new ActivityStore({ journal });
    const renewed = restarted.exportSubmission(submissionId);
    const stated = JSON.parse(renewed.file).exportedAt as string;
    assert.notEqual(stated, '1970-01-01T08:00:00.000Z', 'the new bytes claim the old export time');
    const latest = restarted.view(activityId).submissions[0]?.export;
    assert.deepEqual(latest, {
      state: 'exported-not-sent',
      fileSha256: renewed.fileSha256,
      exportedAt: stated,
    });
    const kept = journal.all().find((event) => event.id === 'evt_audit_older_export');
    assert.deepEqual(kept?.data, older.data);
    assert.equal(kept?.at, '1970-01-01T08:00:00.000Z');
  } finally {
    journal.close();
  }
});

test('audit U13: a re-export the command cannot write journals no renewed export', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'boopy-audit-renewal-'));
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
  const dependencies = {
    journal: test.journal,
    preparation,
    packageForId: (id: string) => test.boopy.package(id),
    supersessions: () => test.boopy.supersessions,
  };
  const serving = connectorApp(test.boopy, {
    token: TOKEN,
    baseUrl: 'http://127.0.0.1',
    logger: false,
  });
  await serving.listen({ host: '127.0.0.1', port: 0 });
  port = (serving.server.address() as AddressInfo).port;
  let local = serving;
  try {
    await preparation.prepare(session.id, { requestId: 'audit-preparation-1', packageId });
    const first = new ActivityStore(dependencies);
    const request = await first.prepareRequest({ packageId, goal: 'Synthetic goal.' });
    const binding = JSON.parse(request.file).respondWith.binding;
    const { activityId } = first.importActivity(activityFile(binding));
    first.arrange(activityId, { revision: 0, positions: { a: 0.2, b: 0.7 } });
    const submissionId = first.submit(activityId, { revision: 1 }).submissions[0]?.submissionId;
    assert.ok(submissionId);
    // The person already holds an export written by an earlier Boopy with other instructions.
    const name = `boopy-activity-submission-${submissionId}.json`;
    const olderBytes = '{"synthetic":"export written by an earlier Boopy"}\n';
    await writeFile(join(out, name), olderBytes, { mode: 0o600 });
    test.journal.append(
      {
        type: 'activity.submission-exported',
        session: session.id,
        actor: 'person',
        data: { submissionId, activityId, fileSha256: sha256(olderBytes), delivery: 'not-sent' },
      },
      'evt_audit_earlier_export',
      '1970-01-01T08:00:00.000Z',
    );
    const store = new ActivityStore(dependencies);
    local = connectorApp(test.boopy, {
      token: TOKEN,
      baseUrl: 'http://127.0.0.1',
      logger: false,
      handoff: preparation,
      activities: store,
    });
    await local.listen({ host: '127.0.0.1', port: 0 });
    const localPort = (local.server.address() as AddressInfo).port;
    const exports = () =>
      test.journal.all().filter((event) => event.type === 'activity.submission-exported').length;
    const before = exports();
    await assert.rejects(exportSubmission({ dataDir, port: localPort, submissionId, outDir: out }));
    assert.equal(await readFile(join(out, name), 'utf8'), olderBytes);
    assert.deepEqual(await readdir(out), [name]);
    assert.equal(exports(), before, 'a renewed export was journaled though no file was written');
    assert.equal(
      store.view(activityId).submissions[0]?.export?.fileSha256,
      sha256(olderBytes),
      'the view now names bytes the person never received',
    );
  } finally {
    if (local !== serving) {
      local.server.closeAllConnections();
      await local.close();
    }
    serving.server.closeAllConnections();
    await serving.close();
    test.journal.close();
    await rm(directory, { recursive: true, force: true });
  }
});
