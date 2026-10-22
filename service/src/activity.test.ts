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

  it('keeps unsupported or invalid bodies as fallback-only with their issues', async () => {
    const test = await setup();
    const cases: [Record<string, unknown>, string][] = [
      [{ ...korean(null), components: [{ type: 'map', pins: [] }] }, 'component'],
      [
        {
          ...morocco(),
          components: [
            {
              type: 'arrange',
              axis: { kind: 'clock' },
              tokens: [{ key: 'a', label: { text: 'Noon', language: 'en' }, sourceId: null }],
            },
          ],
        },
        'axis',
      ],
      [korean('ctx_elsewhere:itm_1'), 'sourceId'],
      [{ ...korean(null), title: 'خيمة' }, SCRIPT_MESSAGE],
      [{ ...korean(null), purpose: 'Read <b>this</b>' }, 'markup'],
      [{ ...korean(null), purpose: 'See www.example.test' }, 'Links'],
    ];
    for (const [body, issue] of cases) {
      const result = test.store.importActivity(file(test, body));
      assert.equal(result.status, 'fallback-only');
      assert.match(result.issues.join('\n'), new RegExp(issue.replace(/[.]/g, '\\.')));
      const view = ActivityView.parse(test.store.view(result.activityId));
      assert.equal(view.title, null);
      assert.equal(view.purpose, null);
      assert.equal(view.instruction, null);
      assert.deepEqual(view.components, []);
      assert.deepEqual(view.hints, { total: 0, revealed: [] });
      assert.equal(view.canSubmit, false);
      assert.equal(
        view.fallbackText,
        'Picture the camel to the left of the tent and say it in Korean.',
      );
      for (const change of [
        () => test.store.arrange(result.activityId, { revision: 0, positions: { a: 0.1 } }),
        () => test.store.sequence(result.activityId, { revision: 0, chosen: [] }),
        () => test.store.revealHint(result.activityId, { revision: 0 }),
        () => test.store.submit(result.activityId, { revision: 0 }),
      ])
        refuses(test, change, 409, 'activity_unavailable');
    }
  });
});

describe('headset changes', () => {
  it('arranges with exactly the token keys and derives the relation', async () => {
    const test = await setup();
    const { activityId } = test.store.importActivity(file(test, korean(test.camel)));
    for (const positions of [
      { a: 0.2 },
      { a: 0.2, b: 0.3, c: 0.4 },
      { a: 0.2, c: 0.4 },
      JSON.parse('{"a":0.2,"b":0.3,"__proto__":0.4}'),
      { a: 0.2, b: 0.3, constructor: 0.4 },
    ])
      zodRefuses(test, () => test.store.arrange(activityId, { revision: 0, positions }));
    for (const positions of [
      { a: -0.0001, b: 0.3 },
      { a: 1.0001, b: 0.3 },
      { a: '0.5', b: 0.3 },
    ])
      zodRefuses(test, () => test.store.arrange(activityId, { revision: 0, positions }));
    for (const revision of ['0', -1, 1.5, 2 ** 53 + 1])
      zodRefuses(test, () =>
        test.store.arrange(activityId, { revision, positions: { a: 0.2, b: 0.3 } }),
      );
    let view = test.store.arrange(activityId, { revision: 0, positions: { a: 0.22, b: null } });
    assert.equal(view.revision, 1);
    assert.equal(view.canSubmit, true);
    const arrange = () => {
      const component = view.components[0];
      assert.ok(component?.type === 'arrange');
      return component;
    };
    assert.equal(arrange().derived.relation, null);
    view = test.store.arrange(activityId, { revision: 1, positions: { a: 0.22, b: 0.71 } });
    assert.deepEqual(arrange().derived, {
      relation: 'left-of',
      matchesTarget: true,
      order: ['a', 'b'],
      ties: false,
      values: null,
    });
    assert.deepEqual(
      arrange().tokens.map((token) => token.position),
      [0.22, 0.71],
    );
    view = test.store.arrange(activityId, { revision: 2, positions: { a: 0.7, b: 0.8 } });
    assert.equal(arrange().derived.relation, 'left-of');
    view = test.store.arrange(activityId, { revision: 3, positions: { a: 0.55, b: 0.5 } });
    assert.equal(arrange().derived.relation, 'unclear');
    assert.equal(arrange().derived.ties, true);
    assert.equal(arrange().derived.matchesTarget, false);
  });

  it('refuses a stale revision with nothing journaled, and only one of two equal changes', async () => {
    const test = await setup();
    const { activityId } = test.store.importActivity(file(test, korean(null)));
    refuses(
      test,
      () => test.store.arrange(activityId, { revision: 1, positions: { a: 0.1, b: 0.9 } }),
      409,
      'stale_activity',
    );
    const results = await Promise.allSettled([
      Promise.resolve().then(() =>
        test.store.arrange(activityId, { revision: 0, positions: { a: 0.1, b: 0.9 } }),
      ),
      Promise.resolve().then(() =>
        test.store.sequence(activityId, { revision: 0, chosen: ['t1'] }),
      ),
    ]);
    assert.deepEqual(results.map((result) => result.status).sort(), ['fulfilled', 'rejected']);
    const rejected = results.find((result) => result.status === 'rejected');
    assert.ok(rejected?.status === 'rejected');
    assert.equal((rejected.reason as BoopyError).code, 'stale_activity');
    const revisions = activityEvents(test.journal)
      .map((event) => ('revision' in event.data ? event.data.revision : null))
      .filter((revision) => revision !== null);
    assert.deepEqual(revisions, [1]);
  });

  it('builds a sequence from distinct tiles of this activity', async () => {
    const test = await setup();
    const { activityId } = test.store.importActivity(file(test, korean(null)));
    for (const chosen of [
      ['t1', 't1'],
      ['t9'],
      ['t6'],
      ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't1'],
    ])
      zodRefuses(test, () => test.store.sequence(activityId, { revision: 0, chosen }));
    const view = test.store.sequence(activityId, { revision: 0, chosen: ['t2', 't4', 't3', 't1'] });
    const sequence = view.components[1];
    assert.ok(sequence?.type === 'sequence');
    assert.equal(sequence.text, '낙타가 텐트 왼쪽에 있어요');
    assert.deepEqual(sequence.chosen, ['t2', 't4', 't3', 't1']);
    const shown = ['t1', 't2', 't3', 't4', 't5'].sort((a, b) =>
      sha256(`${activityId}:${a}`).localeCompare(sha256(`${activityId}:${b}`)),
    );
    assert.deepEqual(
      sequence.tiles.map((tile) => [tile.key, tile.used]),
      shown.map((key) => [key, key !== 't5']),
    );
    assert.deepEqual(test.restart().view(activityId).components[1], sequence);
    const cleared = test.store.sequence(activityId, { revision: 1, chosen: [] });
    const empty = cleared.components[1];
    assert.equal(empty?.type === 'sequence' && empty.text, '');
  });

  it('refuses a change to a component the activity does not have', async () => {
    const test = await setup();
    const { activityId } = test.store.importActivity(file(test, morocco()));
    refuses(
      test,
      () => test.store.sequence(activityId, { revision: 0, chosen: [] }),
      400,
      'invalid_request',
    );
    const words = test.store.importActivity(
      file(test, { ...korean(null), components: [korean(null).components].flat().slice(1) }),
    );
    refuses(
      test,
      () => test.store.arrange(words.activityId, { revision: 0, positions: {} }),
      400,
      'invalid_request',
    );
  });

  it('reveals hints in order until none are left', async () => {
    const test = await setup();
    const { activityId } = test.store.importActivity(file(test, korean(null)));
    let view = test.store.revealHint(activityId, { revision: 0 });
    assert.deepEqual(view.hints.revealed, [
      {
        index: 0,
        text: 'Start with the camel, then say where it is.',
        language: 'en',
        gloss: null,
      },
    ]);
    view = test.store.revealHint(activityId, { revision: 1 });
    assert.equal(view.hints.revealed.length, 2);
    refuses(test, () => test.store.revealHint(activityId, { revision: 2 }), 409, 'no_more_hints');
    const none = test.store.importActivity(file(test, { ...korean(null), hints: [] }));
    refuses(
      test,
      () => test.store.revealHint(none.activityId, { revision: 0 }),
      409,
      'no_more_hints',
    );
  });

  it('submits only something placed or chosen, freezing what the person did', async () => {
    const test = await setup();
    const { activityId } = test.store.importActivity(file(test, korean(null)));
    refuses(test, () => test.store.submit(activityId, { revision: 0 }), 409, 'nothing_to_submit');
    test.store.revealHint(activityId, { revision: 0 });
    refuses(test, () => test.store.submit(activityId, { revision: 1 }), 409, 'nothing_to_submit');
    const view = playKorean(test);
    const [first] = view.submissions;
    assert.ok(first);
    assert.deepEqual(first, {
      submissionId: 'sub_k1',
      number: 1,
      submittedAt: first.submittedAt,
      revision: 4,
      digest:
        'arrange: 낙타 left of 텐트 (your view); requested 낙타 left of 텐트; arrangement matches | sequence: "낙타가 텐트 왼쪽에 있어요" | hints: 1 of 2',
      arrange: {
        positions: { a: 0.22, b: 0.71 },
        relation: 'left-of',
        matchesTarget: true,
        order: ['a', 'b'],
        ties: false,
        values: null,
      },
      sequence: { chosen: ['t2', 't4', 't3', 't1'], text: '낙타가 텐트 왼쪽에 있어요' },
      hintsRevealed: [0],
      hintsRevealedSincePrevious: [0],
      export: null,
      reply: null,
    });
    const id = view.activityId;
    const moved = test.store.arrange(id, { revision: 4, positions: { a: 0.9, b: 0.1 } });
    assert.equal(moved.submissions[0]?.arrange?.relation, 'left-of');
    const again = test.store.submit(id, { revision: 5 });
    assert.equal(again.submissions.length, 2);
    assert.equal(again.submissions[1]?.number, 2);
    assert.equal(again.submissions[1]?.revision, 6);
    assert.match(again.submissions[1]?.digest ?? '', /^arrange: 낙타 right of 텐트 \(your view\)/);
    const submitted = activityEvents(test.journal).filter(
      (event) => event.type === 'activity.submitted',
    );
    assert.equal(submitted.length, 2);
    assert.equal(
      submitted[0]?.type === 'activity.submitted' && submitted[0].data.digest,
      first.digest,
    );
  });

  it('snaps number positions in the view, the submission and the digest', async () => {
    const test = await setup();
    const { activityId } = test.store.importActivity(file(test, morocco()));
    let view = test.store.arrange(activityId, { revision: 0, positions: { a: 0.25 } });
    const arrange = view.components[0];
    assert.ok(arrange?.type === 'arrange');
    assert.deepEqual(
      [arrange.tokens[0]?.position, arrange.tokens[0]?.value, arrange.derived.values],
      [0.25, 50, { a: 50 }],
    );
    view = test.store.submit(activityId, { revision: 1 });
    assert.equal(view.submissions[0]?.digest, 'arrange: My estimate = 50 MAD | hints: 0 of 1');
    assert.deepEqual(view.submissions[0]?.arrange?.values, { a: 50 });
    assert.equal(view.submissions[0]?.sequence, null);
  });
});

describe('replies', () => {
  it('requires an exported submission of that activity, with nothing journaled otherwise', async () => {
    const test = await setup();
    const view = playKorean(test);
    const digest = view.submissions[0]?.digest ?? '';
    refuses(
      test,
      () => test.store.importReply(reply('sub_k1', 'act_k1', digest)),
      409,
      'reply_binding_mismatch',
    );
    const store = recordExport(test, 'sub_k1', 'act_k1');
    const other = store.importActivity(file(test, morocco()));
    for (const content of [
      reply('sub_unknown', 'act_k1', digest),
      reply('sub_k1', other.activityId, digest),
    ])
      refuses({ ...test, store }, () => store.importReply(content), 409, 'reply_binding_mismatch');
    refuses({ ...test, store }, () => store.importReply('[]'), 400, 'activity_unreadable');
    refuses(
      { ...test, store },
      () => store.importReply(reply('sub_k1', 'act_k1', digest, { extra: true })),
      400,
      'activity_invalid',
    );
  });

  it('requires the echo to match the digest apart from whitespace', async () => {
    const test = await setup();
    const digest = playKorean(test).submissions[0]?.digest ?? '';
    const store = recordExport(test, 'sub_k1', 'act_k1');
    const changed = { ...test, store };
    for (const echo of [
      digest.replace('matches', 'match'),
      digest.replace('arrange', 'arr\u{200B}ange'),
      'arrange: My estimate = 50 MAD | hints: 0 of 1',
    ])
      refuses(
        changed,
        () => store.importReply(reply('sub_k1', 'act_k1', echo)),
        409,
        'reply_not_matched',
      );
    const spaced = `  ${digest.replaceAll(' | ', '\n|\t  ')}\n`;
    const result = store.importReply(reply('sub_k1', 'act_k1', spaced));
    assert.deepEqual(result, {
      replyId: 'rep_k1',
      submissionId: 'sub_k1',
      activityId: 'act_k1',
      nextActivityId: null,
      nextStatus: null,
      duplicate: false,
    });
    const view = ActivityView.parse(store.view('act_k1'));
    assert.deepEqual(view.submissions[0]?.reply, {
      replyId: 'rep_k1',
      importedAt: view.submissions[0]?.reply?.importedAt,
      claimedAuthor: 'Grok Bot',
      artifactSha256: view.submissions[0]?.reply?.artifactSha256,
      summary: {
        text: 'Synthetic example reply for rendering tests.',
        language: 'en',
        gloss: null,
      },
      points: [
        {
          about: 'sequence',
          text: 'Synthetic point about the sentence.',
          language: 'en',
          gloss: null,
        },
      ],
      nextActivityId: null,
    });
    const summary = ActivitySummary.parse(
      store.list().find((entry) => entry.activityId === 'act_k1'),
    );
    assert.equal(summary.awaitingReply, false);
    assert.equal(summary.replyAvailable, true);
  });

  it('keeps one reply per submission: identical bytes are idempotent, another reply is refused', async () => {
    const test = await setup();
    const digest = playKorean(test).submissions[0]?.digest ?? '';
    const store = recordExport(test, 'sub_k1', 'act_k1');
    const content = reply('sub_k1', 'act_k1', digest, {
      next: { fallbackText: 'Now say where the tent is.', activity: korean(test.camel) },
    });
    const first = store.importReply(content);
    const again = store.importReply(content);
    assert.deepEqual(again, { ...first, duplicate: true });
    refuses(
      { ...test, store },
      () => store.importReply(reply('sub_k1', 'act_k1', digest)),
      409,
      'reply_exists',
    );
    const events = activityEvents(test.journal);
    assert.equal(events.filter((event) => event.type === 'activity.reply-imported').length, 1);
    assert.equal(
      events.filter((event) => event.type === 'activity.imported' && event.data.parent !== null)
        .length,
      1,
    );
  });
});
