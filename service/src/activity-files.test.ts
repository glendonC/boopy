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

  it("bounds the person's words and refuses unknown fields before reading anything", async () => {
    const test = await setup();
    try {
      await test.prepare();
      for (const input of [
        { packageId: test.packageId, goal: '' },
        { packageId: test.packageId, goal: 'x'.repeat(301) },
        { packageId: test.packageId, goal: 'two\nlines' },
        { packageId: test.packageId, goal: 'Practice.', background: 'b'.repeat(201) },
        { packageId: test.packageId, goal: 'Practice.', personLanguage: 'English' },
        { packageId: test.packageId, goal: 'Practice.', outputPath: '/tmp/x' },
        { packageId: 'ctx_../x', goal: 'Practice.' },
      ]) {
        const before = test.journal.all().length;
        await assert.rejects(test.store.prepareRequest(input), { name: 'ZodError' });
        assert.equal(test.journal.all().length, before);
      }
    } finally {
      await test.close();
    }
  });

  it('gives each concurrent request its own packet read and request ID', async () => {
    const test = await setup();
    try {
      await test.prepare();
      const reads = count(test, 'handoff.packet-read');
      const input = { packageId: test.packageId, goal: 'Practice.' };
      const [a, b] = await Promise.all([
        test.store.prepareRequest(input),
        test.store.prepareRequest(input),
      ]);
      assert.notEqual(a.requestId, b.requestId);
      assert.equal(count(test, 'handoff.packet-read'), reads + 2);
      assert.equal(count(test, 'activity.request-prepared'), 2);
    } finally {
      await test.close();
    }
  });
});

describe('activity submission file', () => {
  it('freezes the exact validated activity, the submission, what Boopy checked and the digest', async () => {
    const test = await setup();
    try {
      const { view, submissionId } = await submitted(test);
      const exported = test.store.exportSubmission(submissionId);
      assert.equal(exported.fileName, `boopy-activity-submission-${submissionId}.json`);
      assert.equal(exported.fileSha256, sha256(exported.file));
      const file = ActivitySubmissionFile.parse(JSON.parse(exported.file));
      const imported = test.journal.all().find((event) => event.type === 'activity.imported');
      assert.ok(imported?.type === 'activity.imported');
      assert.deepEqual(file.activity, {
        claimedAuthor: 'Grok Bot',
        authorship: 'claimed-by-file',
        artifactSha256: imported.data.artifactSha256,
        body: imported.data.activity,
      });
      const submission = view.submissions[0];
      assert.ok(submission);
      assert.equal(file.digest, submission.digest);
      assert.deepEqual(file.submission, {
        number: 1,
        submittedAt: submission.submittedAt,
        revision: 4,
        arrange: submission.arrange,
        sequence: submission.sequence,
        hintsRevealed: [
          {
            index: 0,
            text: 'Start with the camel, then say where it is.',
            language: 'en',
            gloss: null,
          },
        ],
        hintsRevealedSincePrevious: [0],
      });
      assert.deepEqual(file.boopyChecked, {
        arrangementRelation: {
          subject: 'a',
          object: 'b',
          requested: 'left-of',
          arranged: 'left-of',
          matches: true,
        },
      });
      assert.deepEqual(file.respondWith, {
        type: 'boopy.activity-reply',
        version: 1,
        binding: { submissionId, activityId: view.activityId },
        echo: submission.digest,
      });
      assert.equal(file.delivery, 'not-sent-by-boopy');
      assert.equal(file.requestId, 'arq_k1');
      assert.equal(exported.file.includes(test.directory), false);
      assert.equal(exported.file.includes(TOKEN), false);
      const text = file.instructions.join('\n');
      for (const rule of [
        /exactly one downloadable \.json file/,
        /Copy respondWith\.binding and respondWith\.echo exactly/,
        /did not judge whether any answer is correct/,
        /practice construction/,
        /next is null/,
        /hintsRevealed is cumulative/,
        /hintsRevealedSincePrevious lists only the hints opened since the previous submission/,
        /must differ from this activity and target one specific thing this submission shows/,
        /Never repeat the same activity unchanged/,
        /write token labels and tile texts in that language/,
        /include a sequence component in which the person builds the sentence they should say/,
        /only Latin letters or Hangul/,
      ])
        assert.match(text, rule);
      const body = validateActivityBody(file.activity.body, new Set(['ctx_x:y']));
      assert.ok(body.activity || body.issues.every((issue) => issue.includes('sourceId')));
    } finally {
      await test.close();
    }
  });

  it('renders the same bytes on every export, journaled once with the first exportedAt', async () => {
    const test = await setup();
    try {
      const { submissionId } = await submitted(test);
      const [first, second] = await Promise.all([
        Promise.resolve().then(() => test.store.exportSubmission(submissionId)),
        Promise.resolve().then(() => test.store.exportSubmission(submissionId)),
      ]);
      assert.equal(first?.file, second?.file);
      const third = test.store.exportSubmission(submissionId);
      assert.equal(third.file, first?.file);
      const restarted = test.restart().exportSubmission(submissionId);
      assert.equal(restarted.file, first?.file);
      assert.equal(restarted.fileSha256, first?.fileSha256);
      assert.equal(count(test, 'activity.submission-exported'), 1);
      const event = test.journal
        .all()
        .find((entry) => entry.type === 'activity.submission-exported');
      const file = ActivitySubmissionFile.parse(JSON.parse(restarted.file));
      assert.equal(event?.at, file.exportedAt);
      assert.deepEqual(test.restart().view(file.activityId).submissions[0]?.export, {
        state: 'exported-not-sent',
        fileSha256: first?.fileSha256,
        exportedAt: file.exportedAt,
      });
    } finally {
      await test.close();
    }
  });

  it('re-renders a submission an older Boopy exported and records the new bytes once', async () => {
    const test = await setup();
    try {
      const { view, submissionId } = await submitted(test);
      // As if an earlier Boopy had exported it with other instructions.
      test.journal.append(
        {
          type: 'activity.submission-exported',
          session: test.sessionId,
          actor: 'person',
          data: {
            submissionId,
            activityId: view.activityId,
            fileSha256: '0'.repeat(64),
            delivery: 'not-sent',
          },
        },
        'evt_older_export',
        '1970-01-01T09:30:00.000Z',
      );
      const store = test.restart();
      assert.equal(store.view(view.activityId).submissions[0]?.export?.fileSha256, '0'.repeat(64));
      const before = count(test, 'activity.submission-exported');
      const again = store.exportSubmission(submissionId);
      assert.equal(sha256(again.file), again.fileSha256);
      assert.equal(count(test, 'activity.submission-exported'), before + 1);
      const latest = store.view(view.activityId).submissions[0]?.export;
      assert.deepEqual(latest, {
        state: 'exported-not-sent',
        fileSha256: again.fileSha256,
        exportedAt: JSON.parse(again.file).exportedAt,
      });
      assert.equal(store.exportSubmission(submissionId).file, again.file);
      assert.equal(count(test, 'activity.submission-exported'), before + 1);
      assert.deepEqual(test.restart().view(view.activityId).submissions[0]?.export, latest);
    } finally {
      await test.close();
    }
  });

  it('refuses an unknown submission with nothing journaled', async () => {
    const test = await setup();
    try {
      for (const id of ['sub_unknown', ' sub_k1', 'sub_k1/../x'])
        await refuses(test, async () => test.store.exportSubmission(id), 404, 'submission_unknown');
    } finally {
      await test.close();
    }
  });

  it('accepts a reply that echoes the exported digest and opens the next activity', async () => {
    const test = await setup();
    try {
      const { submissionId, file: request } = await submitted(test);
      const exported = ActivitySubmissionFile.parse(
        JSON.parse(test.store.exportSubmission(submissionId).file),
      );
      const reply = test.store.importReply(
        JSON.stringify({
          ...exported.respondWith,
          author: 'Grok Bot',
          reply: {
            summary: { text: 'Synthetic example reply for rendering tests.', language: 'en' },
            points: [
              { about: 'sequence', text: 'Synthetic point about the sentence.', language: 'en' },
            ],
          },
          next: {
            fallbackText: 'Now put the tent to the left of the camel.',
            activity: korean(request.sources[0]?.sourceId ?? null),
          },
        }),
      );
      assert.equal(reply.nextStatus, 'active');
      const next = test.store.view(reply.nextActivityId ?? '');
      assert.equal(next.provenance.requestId, 'arq_k1');
      assert.deepEqual(next.provenance.parent, {
        activityId: exported.activityId,
        submissionId,
        replyId: reply.replyId,
      });
    } finally {
      await test.close();
    }
  });
});

describe('renderers', () => {
  it('render fixed key order, pretty JSON and a trailing newline', async () => {
    const input = {
      requestId: 'arq_k1',
      exportedAt: '1970-01-01T09:00:00.000Z',
      goal: 'Practice.',
      personLanguage: 'en',
      background: null,
      sources: [],
      packageId: 'ctx_synthetic1',
      packetSha256: '1'.repeat(64),
      packet: 'Synthetic packet.\n',
    };
    const rendered = renderRequestFile(input);
    assert.equal(rendered.file, renderRequestFile({ ...input }).file);
    assert.ok(rendered.file.endsWith('}\n'));
    assert.deepEqual(Object.keys(JSON.parse(rendered.file)), [
      'type',
      'version',
      'requestId',
      'exportedAt',
      'delivery',
      'note',
      'goal',
      'personLanguage',
      'background',
      'instructions',
      'respondWith',
      'sources',
      'context',
    ]);
    assert.match(rendered.file, /^\{\n {2}"type": "boopy\.activity-request",\n/);
    const instructions = JSON.parse(rendered.file).instructions.join('\n');
    assert.match(instructions, /label tokens|write token labels and tile texts in that language/);
    assert.match(instructions, /builds the sentence they should say from one-word tiles/);
    const written = join(await mkdtemp(join(tmpdir(), 'boopy-render-')), rendered.fileName);
    await writeFile(written, rendered.file);
    assert.equal(sha256(await readFile(written)), rendered.fileSha256);
  });

  it('says Boopy sent a file only when delivery is sent-by-boopy-to-local-model', () => {
    const request = {
      requestId: 'arq_k1',
      exportedAt: '1970-01-01T09:00:00.000Z',
      goal: 'Practice.',
      personLanguage: 'en',
      background: null,
      sources: [],
      packageId: 'ctx_synthetic1',
      packetSha256: '1'.repeat(64),
      packet: 'Synthetic packet.\n',
    };
    const requestNote =
      'The person exported this file from Boopy and chose to share it. Boopy did not send it.';
    const submissionNote =
      'The person exported this submission from Boopy and chose to share it. Boopy did not send it.';
    const submission = {
      submissionId: 'sub_k1',
      activityId: 'act_k1',
      requestId: 'arq_k1',
      exportedAt: '1970-01-01T09:06:00.000Z',
      claimedAuthor: null,
      artifactSha256: '2'.repeat(64),
      activity: korean(null) as ActivityBody,
      submission: {
        number: 1,
        submittedAt: '1970-01-01T09:04:00.000Z',
        revision: 4,
        positions: null,
        derived: null,
        chosen: null,
        text: null,
        hintsRevealed: [],
        hintsRevealedSincePrevious: [],
        digest: 'synthetic',
      },
    };
    for (const delivery of [undefined, 'not-sent', 'not-sent-by-boopy'] as const) {
      const requested = JSON.parse(
        renderRequestFile({ ...request, ...(delivery ? { delivery } : {}) }).file,
      );
      const submitted = JSON.parse(
        renderSubmissionFile({ ...submission, ...(delivery ? { delivery } : {}) }).file,
      );
      assert.equal(requested.delivery, 'not-sent-by-boopy');
      assert.equal(requested.note, requestNote);
      assert.equal(submitted.delivery, 'not-sent-by-boopy');
      assert.equal(submitted.note, submissionNote);
    }
    const sentRequest = JSON.parse(
      renderRequestFile({ ...request, delivery: 'sent-by-boopy-to-local-model' }).file,
    );
    const sentSubmission = JSON.parse(
      renderSubmissionFile({ ...submission, delivery: 'sent-by-boopy-to-local-model' }).file,
    );
    assert.equal(sentRequest.delivery, 'sent-by-boopy-to-local-model');
    assert.equal(sentRequest.note, 'Boopy sent this request to the local model on this Mac.');
    assert.equal(sentSubmission.delivery, 'sent-by-boopy-to-local-model');
    assert.equal(sentSubmission.note, 'Boopy sent this submission to the local model on this Mac.');
  });
});
