import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ActivityFileError, ActivityStore } from './activity.ts';
import {
  ActivitySummary,
  ActivityView,
  allowedSources,
  SCRIPT_MESSAGE,
  type SourceEntry,
  sha256,
} from './activity-contract.ts';
import { Boopy, BoopyError } from './boopy.ts';
import { evidenceRecords } from './evidence-contract.ts';
import { Journal } from './journal.ts';
import { startRequest, testBoopy } from './testing.ts';

const PACKET = '1'.repeat(64);

type Setup = Awaited<ReturnType<typeof setup>>;

/** A real committed session and a recorded request; U3 writes requests for real. */
async function setup(journal = Journal.open(':memory:')) {
  const test = testBoopy({ journal });
  const view = await test.boopy.start(startRequest('Synthetic camel and tent.'));
  const packageId = test.boopy.commit(view.id).committed?.packageId;
  assert.ok(packageId);
  const sources = allowedSources(test.boopy.package(packageId), test.boopy.supersessions);
  const camels = sources.find((source) => source.label === 'Camels');
  assert.ok(camels);
  recordRequest(journal, view.id, 'arq_k1', packageId, sources);
  const ids = new Map<string, number>();
  let clock = Date.parse('1970-01-01T09:00:00.000Z');
  const dependencies = {
    journal,
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
    journal,
    sessionId: view.id,
    packageId,
    sources,
    camel: camels.sourceId,
    dependencies,
    store: new ActivityStore(dependencies),
    /** A fresh store on the same journal, as after a restart. */
    restart: () => new ActivityStore(dependencies),
  };
}

function recordRequest(
  journal: Journal,
  session: string,
  requestId: string,
  packageId: string,
  sources: SourceEntry[],
) {
  journal.append(
    {
      type: 'activity.request-prepared',
      session,
      actor: 'person',
      data: {
        requestId,
        packageId,
        preparation: {
          requestId: 'synthetic-preparation',
          receiptId: 'handoff_x',
          packetSha256: PACKET,
        },
        goal: 'Practice saying where things are in Korean.',
        personLanguage: 'en',
        background: null,
        sources,
        fileSha256: '9'.repeat(64),
        delivery: 'not-sent',
      },
    },
    `evt_request_${requestId}`,
    '1970-01-01T08:59:00.000Z',
  );
}

function korean(source: string | null): Record<string, unknown> {
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

function morocco(): Record<string, unknown> {
  return {
    title: 'Petit taxi fare',
    purpose: 'Check your sense of a fair petit taxi fare before you ride.',
    instruction: {
      text: 'What would you expect to pay for a daytime petit taxi from the medina to Gueliz?',
      language: 'en',
    },
    components: [
      {
        type: 'arrange',
        axis: { kind: 'number', min: 0, max: 200, step: 5, unit: 'MAD' },
        tokens: [{ key: 'a', label: { text: 'My estimate', language: 'en' }, sourceId: null }],
      },
    ],
    hints: [{ text: 'Think about the distance and the time of day.', language: 'en' }],
  };
}

function file(test: Setup, activity: unknown, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: 'boopy.activity',
    version: 1,
    binding: { requestId: 'arq_k1', packageId: test.packageId, packetSha256: PACKET },
    author: 'Grok Bot',
    fallbackText: 'Picture the camel to the left of the tent and say it in Korean.',
    activity,
    ...extra,
  });
}

function reply(
  submissionId: string,
  activityId: string,
  echo: string,
  extra: Record<string, unknown> = {},
) {
  return JSON.stringify({
    type: 'boopy.activity-reply',
    version: 1,
    binding: { submissionId, activityId },
    author: 'Grok Bot',
    echo,
    reply: {
      summary: { text: 'Synthetic example reply for rendering tests.', language: 'en' },
      points: [{ about: 'sequence', text: 'Synthetic point about the sentence.', language: 'en' }],
    },
    next: null,
    ...extra,
  });
}

/** Asserts a refusal and that the journal did not change. */
function refuses(test: Setup, action: () => unknown, status: number, code: string) {
  const before = test.journal.all().length;
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof BoopyError, String(error));
    assert.equal(error.code, code, error.message);
    assert.equal(error.status, status);
    return true;
  });
  assert.equal(test.journal.all().length, before);
}

function zodRefuses(test: Setup, action: () => unknown) {
  const before = test.journal.all().length;
  assert.throws(action, (error: unknown) => {
    const named = (error as { name?: string }).name;
    assert.ok(
      named === 'ZodError' || (error instanceof BoopyError && error.code === 'invalid_request'),
      String(error),
    );
    return true;
  });
  assert.equal(test.journal.all().length, before);
}

function activityEvents(journal: Journal) {
  return journal.all().filter((event) => event.type.startsWith('activity.'));
}

/** Import, arrange, sequence, reveal a hint and submit, as in the contract's Korean example. */
function playKorean(test: Setup) {
  const imported = test.store.importActivity(file(test, korean(test.camel)));
  const id = imported.activityId;
  test.store.arrange(id, { revision: 0, positions: { a: 0.22, b: 0.71 } });
  test.store.sequence(id, { revision: 1, chosen: ['t2', 't4', 't3', 't1'] });
  test.store.revealHint(id, { revision: 2 });
  return test.store.submit(id, { revision: 3 });
}

/** U3 records exports for real; here the export event is appended and replayed. */
function recordExport(test: Setup, submissionId: string, activityId: string) {
  test.journal.append(
    {
      type: 'activity.submission-exported',
      session: test.sessionId,
      actor: 'person',
      data: { submissionId, activityId, fileSha256: '3'.repeat(64), delivery: 'not-sent' },
    },
    `evt_export_${submissionId}`,
    '1970-01-01T09:06:00.000Z',
  );
  return test.restart();
}

describe('activity import', () => {
  it('records a valid activity bound to its request, in the package session, as the person', async () => {
    const test = await setup();
    const content = file(test, korean(test.camel));
    const result = test.store.importActivity(content);
    assert.deepEqual(result, {
      activityId: 'act_k1',
      status: 'active',
      issues: [],
      duplicate: false,
    });
    const [event] = activityEvents(test.journal).filter(
      (entry) => entry.type === 'activity.imported',
    );
    assert.ok(event?.type === 'activity.imported');
    assert.equal(event.session, test.sessionId);
    assert.equal(event.actor, 'person');
    assert.equal(event.data.container, 'json');
    assert.equal(event.data.claimedAuthor, 'Grok Bot');
    assert.equal(event.data.parent, null);
    const view = ActivityView.parse(test.store.view('act_k1'));
    assert.equal(view.revision, 0);
    assert.equal(view.status, 'active');
    assert.equal(view.canSubmit, false);
    assert.deepEqual(view.provenance, {
      requestId: 'arq_k1',
      packageId: test.packageId,
      packetSha256: PACKET,
      artifactSha256: event.data.artifactSha256,
      claimedAuthor: 'Grok Bot',
      authorship: 'claimed-by-file',
      importedAt: '1970-01-01T09:01:00.000Z',
      parent: null,
    });
    const arrange = view.components[0];
    assert.ok(arrange?.type === 'arrange');
    assert.deepEqual(arrange.tokens[0]?.source, { sourceId: test.camel, label: 'Camels' });
    assert.deepEqual(
      arrange.tokens.map((token) => [token.position, token.value]),
      [
        [null, null],
        [null, null],
      ],
    );
    assert.deepEqual(arrange.derived, {
      relation: null,
      matchesTarget: false,
      order: [],
      ties: false,
      values: null,
    });
    assert.deepEqual(view.hints, { total: 2, revealed: [] });
  });

  it('reads a fenced json block and records the container', async () => {
    const test = await setup();
    const content = `Here is your activity.\n\n\`\`\`json\n${file(test, korean(null))}\n\`\`\`\n`;
    test.store.importActivity(content);
    const [event] = activityEvents(test.journal).filter(
      (entry) => entry.type === 'activity.imported',
    );
    assert.equal(event?.type === 'activity.imported' && event.data.container, 'fenced-json');
  });

  it('refuses a binding that does not match a recorded request, without guessing', async () => {
    const test = await setup();
    const binding = (value: Record<string, unknown>) =>
      file(test, korean(null), {
        binding: { requestId: 'arq_k1', packageId: test.packageId, packetSha256: PACKET, ...value },
      });
    for (const content of [
      binding({ requestId: 'arq_unknown' }),
      binding({ packageId: 'ctx_other' }),
      binding({ packetSha256: '2'.repeat(64) }),
    ])
      refuses(test, () => test.store.importActivity(content), 409, 'activity_binding_mismatch');
    for (const content of [
      binding({ requestId: ' arq_k1' }),
      binding({ requestId: 'ARQ_k1' }),
      binding({ packetSha256: PACKET.toUpperCase().replace(/1/g, 'A') }),
      binding({ requestId: undefined }),
    ])
      refuses(test, () => test.store.importActivity(content), 400, 'activity_invalid');
  });

  it('refuses unreadable and invalid files with nothing journaled', async () => {
    const test = await setup();
    const valid = file(test, korean(null));
    for (const content of [
      'not json',
      `${valid} trailing`,
      `[${valid}]`,
      valid.replace('"version":1', '"version":1,"version":1'),
      valid.replace('"activity":{', '"activity":{"__proto__":{},'),
      valid.replace('"activity":{', `"activity":{"deep":${'['.repeat(40)}${']'.repeat(40)},`),
      `{"pad":"${'a'.repeat(70_000)}"}`,
      `\`\`\`json\n${valid}\n\`\`\`\n\`\`\`\nmore\n\`\`\``,
    ])
      refuses(test, () => test.store.importActivity(content), 400, 'activity_unreadable');
    const before = test.journal.all().length;
    assert.throws(
      () => test.store.importActivity(file(test, korean(null), { extra: 1, author: 'جروك' })),
      (error: unknown) => {
        assert.ok(error instanceof ActivityFileError);
        assert.equal(error.code, 'activity_invalid');
        assert.equal(error.status, 400);
        assert.deepEqual(error.issues, [
          'author: Boopy cannot display this script yet. Use Latin letters or Hangul.',
          'file: Remove the unsupported field "extra".',
        ]);
        return true;
      },
    );
    assert.equal(test.journal.all().length, before);
    refuses(
      test,
      () => test.store.importActivity(file(test, korean(null), { fallbackText: '<b>x</b>' })),
      400,
      'activity_invalid',
    );
  });

  it('returns the existing activity for the same bytes, also when imported together', async () => {
    const test = await setup();
    const content = file(test, korean(null));
    const [first, second] = await Promise.all([
      Promise.resolve().then(() => test.store.importActivity(content)),
      Promise.resolve().then(() => test.store.importActivity(content)),
    ]);
    assert.equal(first?.activityId, second?.activityId);
    assert.deepEqual([first?.duplicate, second?.duplicate].sort(), [false, true]);
    const unsupported = file(test, { ...korean(null), components: [{ type: 'map' }] });
    const a = test.store.importActivity(unsupported);
    const b = test.store.importActivity(unsupported);
    assert.deepEqual(b, { ...a, duplicate: true });
    assert.equal(
      activityEvents(test.journal).filter((event) => event.type === 'activity.imported').length,
      2,
    );
    const respaced = test.store.importActivity(`${content}\n`);
    assert.equal(respaced.duplicate, false);
  });
});
