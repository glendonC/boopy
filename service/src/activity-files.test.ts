import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ActivityStore } from './activity.ts';
import {
  type ActivityBody,
  ActivityRequestFile,
  ActivitySubmissionFile,
  allowedSources,
  sha256,
  validateActivityBody,
} from './activity-contract.ts';
import { renderRequestFile, renderSubmissionFile } from './activity-files.ts';
import { BoopyError } from './boopy.ts';
import { evidenceRecords } from './evidence-contract.ts';
import { HandoffPreparation } from './handoff-preparation.ts';
import { connectorApp } from './http/connector.ts';
import { startRequest, testBoopy } from './testing.ts';

const TOKEN = 'synthetic-activity-files-token';

/** A real committed package, a real connector and a real local preparation, as in main.ts. */
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'boopy-activity-files-'));
  const test = testBoopy();
  const view = await test.boopy.start(startRequest('Synthetic camel and tent.'));
  const photo = view.items.find((item) => item.label === 'Desert photo');
  assert.ok(photo);
  test.boopy.act(view.id, { itemId: photo.id, action: 'reject' });
  const packageId = test.boopy.commit(view.id).committed?.packageId;
  assert.ok(packageId);
  await writeFile(join(directory, 'connector-token'), TOKEN, { mode: 0o600 });
  const app = connectorApp(test.boopy, {
    token: TOKEN,
    baseUrl: 'http://127.0.0.1',
    logger: false,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const preparation = new HandoffPreparation({
    journal: test.journal,
    outputRoot: join(directory, 'handoffs'),
    dataDir: directory,
    port: (app.server.address() as AddressInfo).port,
    packageForId: (id) => test.boopy.package(id),
    sessionForId: (id) => test.boopy.view(id),
    supersessions: () => test.boopy.supersessions,
  });
  const ids = new Map<string, number>();
  let clock = Date.parse('1970-01-01T09:00:00.000Z');
  const dependencies = {
    journal: test.journal,
    preparation,
    packageForId: (id: string) => test.boopy.package(id),
    supersessions: () => test.boopy.supersessions,
    now: () => {
      clock += 60_000;
      return new Date(clock);
    },
    newId: (prefix: 'arq' | 'act' | 'sub' | 'rep' | 'cal') => {
      const next = (ids.get(prefix) ?? 0) + 1;
      ids.set(prefix, next);
      return `${prefix}_k${next}`;
    },
  };
  return {
    ...test,
    directory,
    sessionId: view.id,
    packageId,
    preparation,
    dependencies,
    store: new ActivityStore(dependencies),
    restart: () => new ActivityStore(dependencies),
    async prepare(requestId = 'synthetic-preparation-1') {
      return preparation.prepare(view.id, { requestId, packageId });
    },
    async close() {
      await app.close();
      test.journal.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

type Setup = Awaited<ReturnType<typeof setup>>;

async function refuses(test: Setup, action: () => Promise<unknown>, status: number, code: string) {
  const before = test.journal.all().length;
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof BoopyError, String(error));
    assert.equal(error.code, code, error.message);
    assert.equal(error.status, status);
    return true;
  });
  assert.equal(test.journal.all().length, before);
}

const count = (test: Setup, type: string) =>
  test.journal.all().filter((event) => event.type === type).length;

function korean(source: string | null) {
  return {
    title: 'Camel and tent',
    purpose: 'Practice saying where things are in Korean, using your desert camp.',
    instruction: {
      text: '낙타를 텐트 왼쪽에 놓고 한국어로 말해 보세요.',
      language: 'ko',
      gloss: 'Put the camel to the left of the tent, then say it in Korean.',
    },
    components: [
      {
        type: 'arrange',
        axis: { kind: 'viewer-left-right' },
        tokens: [
          { key: 'a', label: { text: '낙타', language: 'ko', gloss: 'camel' }, sourceId: source },
          { key: 'b', label: { text: '텐트', language: 'ko', gloss: 'tent' }, sourceId: null },
        ],
        target: { subject: 'a', relation: 'left-of', object: 'b' },
      },
      {
        type: 'sequence',
        joiner: 'space',
        language: 'ko',
        tiles: [
          { key: 't1', text: '있어요' },
          { key: 't2', text: '낙타가' },
          { key: 't3', text: '왼쪽에' },
          { key: 't4', text: '텐트' },
          { key: 't5', text: '오른쪽에' },
        ],
      },
    ],
    hints: [
      { text: 'Start with the camel, then say where it is.', language: 'en' },
      { text: 'The place word comes before 있어요.', language: 'en' },
    ],
  };
}

/** Request, import, arrange, sequence, one hint and a submission, through the real store. */
async function submitted(test: Setup) {
  await test.prepare();
  const request = await test.store.prepareRequest({
    packageId: test.packageId,
    goal: 'Practice saying where things are in Korean.',
  });
  const file = ActivityRequestFile.parse(JSON.parse(request.file));
  const camel = file.sources.find((source) => source.label === 'Camels')?.sourceId ?? null;
  const imported = test.store.importActivity(
    JSON.stringify({
      ...file.respondWith,
      author: 'Grok Bot',
      fallbackText: 'Picture the camel to the left of the tent and say it in Korean.',
      activity: korean(camel),
    }),
  );
  const id = imported.activityId;
  test.store.arrange(id, { revision: 0, positions: { a: 0.22, b: 0.71 } });
  test.store.sequence(id, { revision: 1, chosen: ['t2', 't4', 't3', 't1'] });
  test.store.revealHint(id, { revision: 2 });
  const view = test.store.submit(id, { revision: 3 });
  return { request, file, view, submissionId: view.submissions[0]?.submissionId ?? '' };
}

describe('activity request file', () => {
  it('reads the packet only through the local disclosure path and binds to the receipt', async () => {
    const test = await setup();
    try {
      const receipt = await test.prepare();
      const reads = count(test, 'handoff.packet-read');
      const result = await test.store.prepareRequest({
        packageId: test.packageId,
        goal: '  Practice saying where things are in Korean.  ',
        background: 'TOPIK level 2, my own note',
      });
      assert.equal(count(test, 'handoff.packet-read'), reads + 1);
      assert.equal(count(test, 'activity.request-prepared'), 1);
      const read = test.journal.all().findLast((event) => event.type === 'handoff.packet-read');
      assert.equal(read?.type === 'handoff.packet-read' && read.data.via, 'local-operator');
      assert.equal(result.requestId, 'arq_k1');
      assert.equal(result.fileName, 'boopy-activity-request-arq_k1.json');
      assert.equal(result.fileSha256, sha256(result.file));
      const file = ActivityRequestFile.parse(JSON.parse(result.file));
      const packet = await test.preparation.readPacket(test.sessionId, 'synthetic-preparation-1');
      assert.equal(file.context.packet, packet);
      assert.equal(file.context.packetSha256, receipt.packetSha256);
      assert.equal(file.context.packetSha256, sha256(packet));
      assert.deepEqual(file.respondWith, {
        type: 'boopy.activity',
        version: 1,
        binding: {
          requestId: 'arq_k1',
          packageId: test.packageId,
          packetSha256: receipt.packetSha256,
        },
      });
      assert.equal(file.delivery, 'not-sent-by-boopy');
      assert.equal(
        file.note,
        'The person exported this file from Boopy and chose to share it. Boopy did not send it.',
      );
      assert.equal(file.goal, 'Practice saying where things are in Korean.');
      assert.equal(file.background, 'TOPIK level 2, my own note');
      assert.equal(file.personLanguage, 'en');
      assert.equal(result.file.includes(test.directory), false);
      assert.equal(result.file.includes(TOKEN), false);
      const event = test.journal
        .all()
        .findLast((entry) => entry.type === 'activity.request-prepared');
      assert.ok(event?.type === 'activity.request-prepared');
      assert.equal(event.session, test.sessionId);
      assert.equal(event.actor, 'person');
      assert.deepEqual(event.data, {
        requestId: 'arq_k1',
        packageId: test.packageId,
        preparation: {
          requestId: 'synthetic-preparation-1',
          receiptId: receipt.receiptId,
          packetSha256: receipt.packetSha256,
        },
        goal: 'Practice saying where things are in Korean.',
        personLanguage: 'en',
        background: 'TOPIK level 2, my own note',
        sources: file.sources,
        fileSha256: result.fileSha256,
        delivery: 'not-sent',
      });
      assert.equal(event.at, file.exportedAt);
      assert.equal(JSON.stringify(event).includes(packet), false);
    } finally {
      await test.close();
    }
  });

  it('allows the baseline sources except rejected and superseded ones', async () => {
    const test = await setup();
    try {
      const next = await test.boopy.start(startRequest('Synthetic correction.'));
      const nextId = test.boopy.commit(next.id).committed?.packageId;
      assert.ok(nextId);
      const tents = evidenceRecords(test.boopy.package(test.packageId)).find(
        (record) => record.label === 'Tents',
      );
      const successor = evidenceRecords(test.boopy.package(nextId)).find(
        (record) => record.label === 'Tents',
      );
      assert.ok(tents && successor);
      test.boopy.supersede({ predecessor: tents, successor });
      await test.prepare();
      const result = await test.store.prepareRequest({
        packageId: test.packageId,
        goal: 'Practice.',
      });
      const file = ActivityRequestFile.parse(JSON.parse(result.file));
      const records = evidenceRecords(test.boopy.package(test.packageId));
      assert.deepEqual(
        file.sources.map((source) => source.sourceId),
        records
          .filter(
            (record) => record.disposition !== 'rejected' && record.sourceId !== tents.sourceId,
          )
          .map((record) => record.sourceId),
      );
      assert.deepEqual(
        file.sources,
        allowedSources(test.boopy.package(test.packageId), test.boopy.supersessions),
      );
      assert.ok(file.sources.every((source) => source.label !== 'Desert photo'));
    } finally {
      await test.close();
    }
  });

  it('tells the assistant every rule the contract names', async () => {
    const test = await setup();
    try {
      await test.prepare();
      const result = await test.store.prepareRequest({
        packageId: test.packageId,
        goal: 'Practice.',
      });
      const text = ActivityRequestFile.parse(JSON.parse(result.file)).instructions.join('\n');
      for (const rule of [
        /exactly one downloadable \.json file/,
        /whole content is one JSON object shaped like respondWith/,
        /Copy respondWith\.binding exactly/,
        /viewer-left-right/,
        /scale/,
        /number/,
        /sequence/,
        /source IDs listed in sources, or null/,
        /practice construction, not an event/,
        /Do not invent the person's level, feelings, activities or dates/,
        /background is null/,
        /each space tile one spaced word/,
        /never put the full answer anywhere in the file/,
        /Order hints from gentle to specific/,
        /fallbackText as a plain-text version of the same activity/,
        /only Latin letters or Hangul/,
        /practice in a language \(for example Korean\), write token labels and tile texts in that language/,
        /put the translation into the person's language in each gloss/,
        /include a sequence component in which the person builds the sentence they should say/,
        /every word it needs and one or two plausible extra words/,
        /hints that help with this activity only/,
      ])
        assert.match(text, rule);
      // The prepared packet is copied byte for byte; everything Boopy adds around it is checked.
      const parsed = JSON.parse(result.file);
      const added = JSON.stringify({ ...parsed, context: { ...parsed.context, packet: '' } });
      assert.equal(added.includes(String.fromCharCode(0x2014)), false);
    } finally {
      await test.close();
    }
  });

  it('refuses without a single current preparation, with nothing journaled and no packet text', async () => {
    const test = await setup();
    try {
      const input = { packageId: test.packageId, goal: 'Practice.' };
      await refuses(test, () => test.store.prepareRequest(input), 404, 'prepared_unavailable');
      await test.prepare('synthetic-preparation-1');
      await test.prepare('synthetic-preparation-2');
      await refuses(test, () => test.store.prepareRequest(input), 404, 'prepared_unavailable');
      const other = await test.boopy.start(startRequest('Another synthetic package.'));
      const otherId = test.boopy.commit(other.id).committed?.packageId;
      assert.ok(otherId);
      await refuses(
        test,
        () =>
          test.store.prepareRequest({
            ...input,
            packageId: otherId,
            preparationRequestId: 'synthetic-preparation-1',
          }),
        404,
        'prepared_unavailable',
      );
      const packet = await test.preparation.readPacket(test.sessionId, 'synthetic-preparation-1');
      const receipt = test.preparation.status(test.sessionId, 'synthetic-preparation-1');
      assert.ok(receipt?.state === 'prepared-local');
      const path = join(
        test.directory,
        'handoffs',
        `${receipt.receiptId}-attempt-${receipt.attempt}`,
        'manual-handoff-packet.txt',
      );
      await writeFile(path, `${packet}\nSYNTHETIC TAMPERING`);
      await assert.rejects(
        test.store.prepareRequest({ ...input, preparationRequestId: 'synthetic-preparation-1' }),
        (error: unknown) => {
          assert.ok(error instanceof BoopyError);
          assert.equal(error.code, 'prepared_unavailable');
          assert.equal(error.message.includes('SYNTHETIC'), false);
          return true;
        },
      );
      await writeFile(path, packet);
      const valid = await test.store.prepareRequest({
        ...input,
        preparationRequestId: 'synthetic-preparation-2',
      });
      assert.equal(valid.requestId, 'arq_k1');
      const next = await test.boopy.start(startRequest('Synthetic successor.'));
      const nextId = test.boopy.commit(next.id).committed?.packageId;
      assert.ok(nextId);
      const predecessor = evidenceRecords(test.boopy.package(test.packageId))[0];
      const successor = evidenceRecords(test.boopy.package(nextId))[0];
      assert.ok(predecessor && successor);
      test.boopy.supersede({ predecessor, successor });
      await refuses(
        test,
        () =>
          test.store.prepareRequest({ ...input, preparationRequestId: 'synthetic-preparation-2' }),
        409,
        'sources_changed',
      );
    } finally {
      await test.close();
    }
  });
});
