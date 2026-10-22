/** Adversarial checks of the activity store, files and routes: disclosure, guards, revisions,
 * idempotency, isolation and replay (contract sections 1 to 8, audit cases A1, A2, A6, A7, A10). */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { ActivityStore } from '../activity.ts';
import { sha256 } from '../activity-contract.ts';
import { evidenceRecords } from '../evidence-contract.ts';
import { HandoffPreparation } from '../handoff-preparation.ts';
import { connectorApp } from '../http/connector.ts';
import { headsetApp } from '../http/headset.ts';
import { Journal } from '../journal.ts';
import { startRequest, testBoopy } from '../testing.ts';

const TOKEN = 'synthetic-audit-activity-token';
const GOAL = 'Synthetic goal marker 4417';
const BACKGROUND = 'Synthetic background marker 9921';

/** A real committed package, connector, preparation, store and both apps over one journal. */
async function build(directory: string, journal: Journal) {
  const test = testBoopy({ journal });
  const serving = connectorApp(test.boopy, {
    token: TOKEN,
    baseUrl: 'http://127.0.0.1',
    logger: false,
  });
  await serving.listen({ host: '127.0.0.1', port: 0 });
  const preparation = new HandoffPreparation({
    journal,
    outputRoot: join(directory, 'handoffs'),
    dataDir: directory,
    port: (serving.server.address() as AddressInfo).port,
    packageForId: (id) => test.boopy.package(id),
    sessionForId: (id) => test.boopy.view(id),
    supersessions: () => test.boopy.supersessions,
  });
  const store = new ActivityStore({
    journal,
    preparation,
    packageForId: (id) => test.boopy.package(id),
    supersessions: () => test.boopy.supersessions,
  });
  const local = connectorApp(test.boopy, {
    token: TOKEN,
    baseUrl: 'https://fictional.example',
    logger: false,
    handoff: preparation,
    activities: store,
  });
  const headset = headsetApp(test.boopy, {
    logger: false,
    handoff: preparation,
    activities: store,
  });
  return {
    boopy: test.boopy,
    preparation,
    store,
    local,
    headset,
    async close() {
      serving.server.closeAllConnections();
      await serving.close();
    },
  };
}

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'boopy-audit-activity-'));
  await writeFile(join(directory, 'connector-token'), TOKEN, { mode: 0o600 });
  const journalPath = join(directory, 'journal.sqlite');
  const journal = Journal.open(journalPath);
  const built = await build(directory, journal);
  const view = await built.boopy.start(startRequest('Synthetic camel and tent.'));
  const photo = view.items.find((item) => item.label === 'Desert photo');
  assert.ok(photo);
  built.boopy.act(view.id, { itemId: photo.id, action: 'reject' });
  const packageId = built.boopy.commit(view.id).committed?.packageId;
  assert.ok(packageId);
  const state = { journal, built };
  const call = (
    app: FastifyInstance,
    method: 'GET' | 'POST',
    url: string,
    payload?: unknown,
    headers: Record<string, string> = {},
    remoteAddress = '127.0.0.1',
  ) =>
    app.inject({
      method,
      url,
      remoteAddress,
      headers: { host: '127.0.0.1', ...headers },
      ...(payload === undefined
        ? {}
        : typeof payload === 'string'
          ? {
              payload,
              headers: { host: '127.0.0.1', 'content-type': 'application/json', ...headers },
            }
          : { payload: payload as object }),
    });
  return {
    directory,
    sessionId: view.id,
    packageId,
    get journal() {
      return state.journal;
    },
    get built() {
      return state.built;
    },
    events: () => state.journal.all(),
    count: () => state.journal.all().length,
    prepare: (requestId = 'synthetic-preparation-1') =>
      state.built.preparation.prepare(view.id, { requestId, packageId }),
    local: (
      method: 'GET' | 'POST',
      url: string,
      payload?: unknown,
      headers = {},
      remote?: string,
    ) =>
      call(
        state.built.local,
        method,
        url,
        payload,
        { authorization: `Bearer ${TOKEN}`, ...headers },
        remote,
      ),
    bare: (
      method: 'GET' | 'POST',
      url: string,
      payload: unknown,
      headers: Record<string, string>,
    ) => call(state.built.local, method, url, payload, headers),
    headset: (method: 'GET' | 'POST', url: string, payload?: unknown, headers = {}) =>
      call(state.built.headset, method, url, payload, headers),
    async restart() {
      await state.built.close();
      state.journal.close();
      state.journal = Journal.open(journalPath);
      state.built = await build(directory, state.journal);
    },
    async close() {
      await state.built.close();
      state.journal.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
type Setup = Awaited<ReturnType<typeof setup>>;

function koreanBody(sourceId: string | null, title = 'Camel and tent') {
  return {
    title,
    purpose: 'Practice saying where things are in Korean, using your desert camp.',
    instruction: { text: 'Put the camel to the left of the tent.', language: 'en' },
    components: [
      {
        type: 'arrange',
        axis: { kind: 'viewer-left-right' },
        tokens: [
          { key: 'a', label: { text: 'camel', language: 'en' }, sourceId },
          { key: 'b', label: { text: 'tent', language: 'en' }, sourceId: null },
        ],
        target: { subject: 'a', relation: 'left-of', object: 'b' },
      },
      {
        type: 'sequence',
        joiner: 'space',
        language: 'en',
        tiles: [
          { key: 't1', text: 'is' },
          { key: 't2', text: 'camel' },
          { key: 't3', text: 'left' },
          { key: 't4', text: 'the' },
        ],
      },
    ],
    hints: [
      { text: 'Start with the camel.', language: 'en' },
      { text: 'Say where it is.', language: 'en' },
    ],
  };
}

type RequestFile = {
  respondWith: { binding: Record<string, string> };
  sources: { sourceId: string }[];
  context: { packageId: string; packetSha256: string; packet: string };
};

function activityContent(requestFile: RequestFile, body: unknown = koreanBody(null)) {
  return JSON.stringify({
    type: 'boopy.activity',
    version: 1,
    binding: requestFile.respondWith.binding,
    author: 'Synthetic Assistant',
    fallbackText: 'Picture the camel to the left of the tent.',
    activity: body,
  });
}

async function requestFile(t: Setup): Promise<{ file: string; parsed: RequestFile }> {
  const response = await t.local('POST', '/v1/local-activities/requests', {
    packageId: t.packageId,
    goal: GOAL,
    background: BACKGROUND,
  });
  assert.equal(response.statusCode, 200, response.body);
  const file = response.json().file as string;
  return { file, parsed: JSON.parse(file) };
}

async function imported(t: Setup, body?: unknown) {
  const request = await requestFile(t);
  const response = await t.local('POST', '/v1/local-activities/imports', {
    content: activityContent(request.parsed, body),
  });
  assert.equal(response.statusCode, 200, response.body);
  return { request, activityId: response.json().activityId as string };
}

/** Request, import, arrange, sequence, a hint, a submission, an export and a reply with next. */
async function loop(t: Setup) {
  const { request, activityId } = await imported(t);
  const at = `/v1/activities/${activityId}`;
  for (const [path, body] of [
    ['arrangement', { revision: 0, positions: { a: 0.2, b: 0.7 } }],
    ['sequence', { revision: 1, chosen: ['t2', 't4', 't3', 't1'] }],
    ['hints', { revision: 2 }],
    ['submissions', { revision: 3 }],
  ] as const) {
    const response = await t.headset('POST', `${at}/${path}`, body);
    assert.equal(response.statusCode, 200, response.body);
  }
  const view = (await t.headset('GET', at)).json();
  const submissionId = view.submissions[0].submissionId as string;
  const exported = await t.local('POST', `/v1/local-activities/submissions/${submissionId}/export`);
  assert.equal(exported.statusCode, 200, exported.body);
  const submissionFile = JSON.parse(exported.json().file);
  const reply = (summary: string) =>
    JSON.stringify({
      type: 'boopy.activity-reply',
      version: 1,
      binding: submissionFile.respondWith.binding,
      author: 'Synthetic Assistant',
      echo: submissionFile.respondWith.echo,
      reply: {
        summary: { text: summary, language: 'en' },
        points: [{ about: 'sequence', text: 'Synthetic point.', language: 'en' }],
      },
      next: { fallbackText: 'Synthetic next activity.', activity: koreanBody(null, 'Next step') },
    });
  const replied = await t.local('POST', '/v1/local-activities/replies', {
    content: reply('Synthetic summary.'),
  });
  assert.equal(replied.statusCode, 200, replied.body);
  return { request, activityId, submissionId, exported: exported.json(), reply, replied };
}

const types = (events: { type: string }[]) => events.map((event) => event.type);

test('audit batch-1: a request file is disclosed through readPacket once and carries no secrets', async () => {
  const t = await setup();
  try {
    await t.prepare();
    const before = t.count();
    const request = await requestFile(t);
    const added = t.events().slice(before);
    assert.deepEqual(types(added), ['handoff.packet-read', 'activity.request-prepared']);
    const receipt = t.built.preparation.forPackage(t.packageId).receipt;
    assert.equal(request.parsed.context.packetSha256, receipt.packetSha256);
    assert.equal(sha256(request.parsed.context.packet), receipt.packetSha256);
    assert.equal(added[0]?.data && 'packetSha256' in added[0].data, true);
    const prepared = added[1]?.data as Record<string, unknown>;
    assert.deepEqual(Object.keys(prepared).sort(), [
      'background',
      'delivery',
      'fileSha256',
      'goal',
      'packageId',
      'personLanguage',
      'preparation',
      'requestId',
      'sources',
    ]);
    assert.equal(prepared.fileSha256, sha256(request.file));
    for (const secret of [TOKEN, t.directory, 'handoffs', 'connector-token'])
      assert.equal(request.file.includes(secret), false, secret);
    const pkg = t.built.boopy.package(t.packageId);
    const rejected = evidenceRecords(pkg).filter((record) => record.disposition === 'rejected');
    assert.ok(rejected.length > 0);
    for (const record of rejected)
      assert.equal(
        request.parsed.sources.some((source) => source.sourceId === record.sourceId),
        false,
      );
  } finally {
    await t.close();
  }
});

test('audit batch-1: refused request exports journal nothing and return no packet', async () => {
  const t = await setup();
  try {
    const refused = async (payload: unknown, status: number, code: string) => {
      const before = t.count();
      const response = await t.local('POST', '/v1/local-activities/requests', payload);
      assert.equal(response.statusCode, status, response.body);
      assert.deepEqual(Object.keys(response.json()), ['error']);
      assert.equal(response.json().error.code, code);
      assert.equal(t.count(), before);
    };
    const goal = { packageId: t.packageId, goal: GOAL };
    await refused(goal, 404, 'prepared_unavailable');
    await t.prepare('synthetic-preparation-1');
    await t.prepare('synthetic-preparation-2');
    await refused(goal, 404, 'prepared_unavailable');
    await refused(
      { ...goal, preparationRequestId: 'synthetic-unknown' },
      404,
      'prepared_unavailable',
    );
    await refused({ ...goal, packageId: 'ctx_unknown' }, 404, 'prepared_unavailable');
    const receipt = t.built.preparation.forPackage(t.packageId, 'synthetic-preparation-1').receipt;
    const packetPath = join(
      t.directory,
      'handoffs',
      `${receipt.receiptId}-attempt-1`,
      'manual-handoff-packet.txt',
    );
    await writeFile(packetPath, 'synthetic tampering');
    await refused(
      { ...goal, preparationRequestId: 'synthetic-preparation-1' },
      404,
      'prepared_unavailable',
    );
    const next = await t.built.boopy.start(startRequest('Synthetic successor.'));
    const nextId = t.built.boopy.commit(next.id).committed?.packageId;
    assert.ok(nextId);
    const predecessor = evidenceRecords(t.built.boopy.package(t.packageId))[0];
    const successor = evidenceRecords(t.built.boopy.package(nextId))[0];
    assert.ok(predecessor && successor);
    t.built.boopy.supersede({ predecessor, successor });
    await refused(
      { ...goal, preparationRequestId: 'synthetic-preparation-2' },
      409,
      'sources_changed',
    );
  } finally {
    await t.close();
  }
});

test('audit U4: local activity routes need the token and the local-only guard', async () => {
  const t = await setup();
  try {
    await t.prepare();
    const routes: [string, unknown][] = [
      ['/v1/local-activities/requests', { packageId: t.packageId, goal: GOAL }],
      ['/v1/local-activities/imports', { content: '{}' }],
      ['/v1/local-activities/submissions/sub_unknown/export', undefined],
      ['/v1/local-activities/replies', { content: '{}' }],
    ];
    const before = t.count();
    for (const [url, payload] of routes) {
      const expect = async (response: Promise<{ statusCode: number }>, status: number) =>
        assert.equal((await response).statusCode, status, `${url} ${status}`);
      await expect(t.bare('POST', url, payload, {}), 401);
      await expect(
        t.bare('POST', url, payload, { authorization: `Bearer ${'x'.repeat(TOKEN.length)}` }),
        401,
      );
      for (const headers of [
        { host: 'fictional.example' },
        { origin: 'null' },
        { origin: 'http://localhost' },
        { origin: '' },
        { forwarded: 'for=127.0.0.1' },
        { 'x-forwarded-for': '127.0.0.1' },
        { 'x-forwarded-host': '127.0.0.1' },
        { 'x-real-ip': '127.0.0.1' },
      ])
        await expect(t.local('POST', url, payload, headers), 403);
      await expect(t.local('POST', url, payload, {}, '192.0.2.1'), 403);
      await expect(t.local('POST', url, payload, {}, '::ffff:192.0.2.1'), 403);
      const encoded = url.replace('local-activities', 'local%2Dactivities');
      assert.ok((await t.bare('POST', encoded, payload, {})).statusCode >= 400, encoded);
    }
    assert.equal(t.count(), before);
    const openapi = await t.built.local.inject({
      url: '/openapi.json',
      headers: { host: '127.0.0.1' },
    });
    assert.equal(openapi.body.includes('local-activities'), false);
    assert.equal(openapi.body.includes('activities'), false);
  } finally {
    await t.close();
  }
});

test('audit U4: headset activity routes refuse any Origin and leak no packet, goal or path', async () => {
  const t = await setup();
  try {
    await t.prepare();
    const { request, activityId } = await imported(t);
    const at = `/v1/activities/${activityId}`;
    const before = t.count();
    const changes: [string, unknown][] = [
      ['arrangement', { revision: 0, positions: { a: 0.2, b: 0.7 } }],
      ['sequence', { revision: 0, chosen: ['t1'] }],
      ['hints', { revision: 0 }],
      ['submissions', { revision: 0 }],
    ];
    for (const origin of ['null', '', 'http://127.0.0.1', 'http://localhost:47900', 'file://']) {
      assert.equal(
        (await t.headset('GET', '/v1/activities', undefined, { origin })).statusCode,
        403,
      );
      assert.equal((await t.headset('GET', at, undefined, { origin })).statusCode, 403);
      for (const [path, body] of changes)
        assert.equal(
          (await t.headset('POST', `${at}/${path}`, body, { origin })).statusCode,
          403,
          `${path} ${origin}`,
        );
    }
    for (const host of ['fictional.example', '127.0.0.1.nip.io', 'localhost.'])
      assert.equal((await t.headset('GET', at, undefined, { host })).statusCode, 403, host);
    assert.equal(t.count(), before);
    for (const path of [
      `/v1/activities/${activityId.replace('_', '%5F')}`,
      `/v1/activities/${activityId}%20`,
      `/v1/activities/%20${activityId}`,
      `/v1/activities/${activityId.toUpperCase()}`,
      '/v1/activities/__proto__',
      '/v1/activities/constructor',
    ]) {
      const response = await t.headset('GET', path);
      assert.equal(response.statusCode, 404, path);
    }
    const responses = [await t.headset('GET', '/v1/activities'), await t.headset('GET', at)];
    for (const response of responses) {
      assert.equal(response.statusCode, 200);
      assert.equal(response.headers['cache-control'], 'no-store');
      for (const secret of [
        GOAL,
        BACKGROUND,
        TOKEN,
        t.directory,
        request.parsed.context.packet.slice(0, 80),
        '"packet"',
        '"goal"',
      ])
        assert.equal(response.body.includes(secret), false, secret);
    }
  } finally {
    await t.close();
  }
});

test('audit U4: stale, concurrent and malformed headset changes journal nothing', async () => {
  const t = await setup();
  try {
    await t.prepare();
    const { activityId } = await imported(t);
    const at = `/v1/activities/${activityId}`;
    const status = async (path: string, body: unknown, expected: number, code?: string) => {
      const before = t.count();
      const response = await t.headset('POST', `${at}/${path}`, body);
      assert.equal(
        response.statusCode,
        expected,
        `${path} ${JSON.stringify(body)} ${response.body}`,
      );
      if (code) assert.equal(response.json().error.code, code);
      if (expected !== 200) assert.equal(t.count(), before, `${path} journaled on refusal`);
    };
    for (const body of [
      { revision: '0', positions: { a: 0.2, b: 0.7 } },
      { revision: -1, positions: { a: 0.2, b: 0.7 } },
      { revision: 0.5, positions: { a: 0.2, b: 0.7 } },
      { revision: 2 ** 53, positions: { a: 0.2, b: 0.7 } },
      { revision: 0, positions: { a: 0.2 } },
      { revision: 0, positions: { a: 0.2, b: 0.7, c: 0.1 } },
      { revision: 0, positions: { a: 0.2, b: 0.7, constructor: 0.1 } },
      { revision: 0, positions: { a: -0.0001, b: 0.7 } },
      { revision: 0, positions: { a: 1.0001, b: 0.7 } },
      { revision: 0, positions: { a: '0.5', b: 0.7 } },
      { revision: 0 },
      { revision: 0, positions: { a: 0.2, b: 0.7 }, extra: true },
      '{"revision":0,"positions":{"a":0.2,"b":0.7,"__proto__":{"x":1}}}',
      '{"revision":0,"positions":{"a":0.2,"b":0.7}',
    ])
      await status('arrangement', body, 400);
    for (const chosen of [
      ['t1', 't1'],
      ['t9'],
      ['T1'],
      ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't1'],
    ])
      await status('sequence', { revision: 0, chosen }, 400);
    await status('submissions', { revision: 0 }, 409, 'nothing_to_submit');
    await status(
      'arrangement',
      { revision: 1, positions: { a: 0.2, b: 0.7 } },
      409,
      'stale_activity',
    );
    const before = t.count();
    const racing = await Promise.all(
      [0.2, 0.3].map((a) =>
        t.headset('POST', `${at}/arrangement`, { revision: 0, positions: { a, b: 0.7 } }),
      ),
    );
    assert.deepEqual(racing.map((response) => response.statusCode).sort(), [200, 409]);
    assert.equal(t.count(), before + 1);
    await status('hints', { revision: 1 }, 200);
    await status('hints', { revision: 2 }, 200);
    await status('hints', { revision: 3 }, 409, 'no_more_hints');
    const revisions = t
      .events()
      .filter((event) => event.type.startsWith('activity.') && 'revision' in event.data)
      .map((event) => (event.data as { revision: number }).revision);
    assert.deepEqual(revisions, [1, 2, 3]);
    const fallback = await imported(t, { title: 'Broken', components: [{ type: 'map' }] });
    for (const [path, body] of [
      ['arrangement', { revision: 0, positions: { a: 0.2, b: 0.7 } }],
      ['sequence', { revision: 0, chosen: ['t1'] }],
      ['hints', { revision: 0 }],
      ['submissions', { revision: 0 }],
    ] as const) {
      const before2 = t.count();
      const response = await t.headset(
        'POST',
        `/v1/activities/${fallback.activityId}/${path}`,
        body,
      );
      assert.equal(response.statusCode, 409, path);
      assert.equal(response.json().error.code, 'activity_unavailable');
      assert.equal(t.count(), before2);
    }
    const unknown = await t.headset('POST', '/v1/activities/act_unknown/hints', { revision: 0 });
    assert.equal(unknown.statusCode, 404);
    assert.equal(unknown.json().error.code, 'activity_unknown');
  } finally {
    await t.close();
  }
});

test('audit batch-1: imports, replies and exports are idempotent, also when concurrent', async () => {
  const t = await setup();
  try {
    await t.prepare();
    const request = await requestFile(t);
    const content = activityContent(request.parsed);
    const before = t.count();
    const [first, second] = await Promise.all(
      [content, content].map((text) =>
        t.local('POST', '/v1/local-activities/imports', { content: text }),
      ),
    );
    assert.equal(first?.statusCode, 200);
    assert.equal(second?.statusCode, 200);
    assert.equal(first?.json().activityId, second?.json().activityId);
    assert.deepEqual([first?.json().duplicate, second?.json().duplicate].sort(), [false, true]);
    assert.equal(t.count(), before + 1);
    const run = await loop(t);
    const count = (type: string) => t.events().filter((event) => event.type === type).length;
    const replies = count('activity.reply-imported');
    const imports = count('activity.imported');
    const again = await t.local('POST', '/v1/local-activities/replies', {
      content: run.reply('Synthetic summary.'),
    });
    assert.equal(again.statusCode, 200);
    assert.equal(again.json().duplicate, true);
    assert.equal(again.json().nextActivityId, run.replied.json().nextActivityId);
    const other = await t.local('POST', '/v1/local-activities/replies', {
      content: run.reply('A different synthetic summary.'),
    });
    assert.equal(other.statusCode, 409);
    assert.equal(other.json().error.code, 'reply_exists');
    assert.equal(count('activity.reply-imported'), replies);
    assert.equal(count('activity.imported'), imports);
    const url = `/v1/local-activities/submissions/${run.submissionId}/export`;
    const exports = await Promise.all([t.local('POST', url), t.local('POST', url)]);
    for (const response of exports) assert.equal(response.json().file, run.exported.file);
    assert.equal(count('activity.submission-exported'), 1);
    await t.restart();
    const after = await t.local('POST', url);
    assert.equal(after.json().file, run.exported.file);
    assert.equal(after.json().fileSha256, run.exported.fileSha256);
    assert.equal(count('activity.submission-exported'), 1);
  } finally {
    await t.close();
  }
});

test('audit batch-1: activity events never touch sessions or packages and replay after restart', async () => {
  const t = await setup();
  try {
    await t.prepare();
    const packages = JSON.stringify(t.built.boopy.packages());
    const session = JSON.stringify({ ...t.built.boopy.view(t.sessionId), notice: null });
    const disclosures = t.built.boopy.disclosures.length;
    const before = t.count();
    const run = await loop(t);
    const added = t.events().slice(before);
    for (const event of added) {
      assert.ok(
        event.type.startsWith('activity.') || event.type === 'handoff.packet-read',
        event.type,
      );
      assert.equal(event.session, t.sessionId, event.type);
    }
    assert.equal(JSON.stringify(t.built.boopy.packages()), packages);
    assert.equal(JSON.stringify({ ...t.built.boopy.view(t.sessionId), notice: null }), session);
    assert.equal(t.built.boopy.disclosures.length, disclosures);
    const ids = [run.activityId, run.replied.json().nextActivityId as string];
    const list = JSON.stringify(t.built.store.list());
    const views = ids.map((id) => JSON.stringify(t.built.store.view(id)));
    const length = t.count();
    await t.restart();
    assert.equal(t.count(), length, 'startup appended events');
    assert.equal(JSON.stringify(t.built.store.list()), list);
    assert.deepEqual(
      ids.map((id) => JSON.stringify(t.built.store.view(id))),
      views,
    );
    assert.equal(JSON.stringify(t.built.boopy.packages()), packages);
    assert.equal(JSON.stringify({ ...t.built.boopy.view(t.sessionId), notice: null }), session);
    assert.equal(t.built.preparation.forPackage(t.packageId).state, 'prepared-local');
  } finally {
    await t.close();
  }
});

test('audit batch-1: binding and echo mismatches journal nothing and never pick a request', async () => {
  const t = await setup();
  try {
    await t.prepare();
    const first = await requestFile(t);
    const refused = async (url: string, content: string, status: number, code: string) => {
      const before = t.count();
      const response = await t.local('POST', url, { content });
      assert.equal(response.statusCode, status, response.body);
      assert.equal(response.json().error.code, code);
      assert.equal(t.count(), before);
    };
    const imports = '/v1/local-activities/imports';
    const bound = (binding: Record<string, string>) =>
      activityContent({ ...first.parsed, respondWith: { binding } });
    const binding = first.parsed.respondWith.binding;
    await refused(
      imports,
      bound({ ...binding, requestId: 'arq_unknown' }),
      409,
      'activity_binding_mismatch',
    );
    await refused(
      imports,
      bound({ ...binding, packageId: 'ctx_other' }),
      409,
      'activity_binding_mismatch',
    );
    await refused(
      imports,
      bound({ ...binding, packetSha256: 'f'.repeat(64) }),
      409,
      'activity_binding_mismatch',
    );
    await refused(
      imports,
      bound({ ...binding, packetSha256: (binding.packetSha256 as string).toUpperCase() }),
      400,
      'activity_invalid',
    );
    const run = await loop(t);
    const replies = '/v1/local-activities/replies';
    const reply = JSON.parse(run.reply('Synthetic summary two.'));
    const content = (change: Record<string, unknown>) => JSON.stringify({ ...reply, ...change });
    await refused(
      replies,
      content({ binding: { ...reply.binding, submissionId: 'sub_unknown' } }),
      409,
      'reply_binding_mismatch',
    );
    await refused(
      replies,
      content({ binding: { ...reply.binding, activityId: run.replied.json().nextActivityId } }),
      409,
      'reply_binding_mismatch',
    );
    const view = (await t.headset('GET', `/v1/activities/${run.activityId}`)).json();
    const fresh = await t.headset('POST', `/v1/activities/${run.activityId}/submissions`, {
      revision: view.revision,
    });
    assert.equal(fresh.statusCode, 200, fresh.body);
    const unexported = fresh.json().submissions.at(-1).submissionId as string;
    await refused(
      replies,
      content({ binding: { ...reply.binding, submissionId: unexported } }),
      409,
      'reply_binding_mismatch',
    );
    await t.local('POST', `/v1/local-activities/submissions/${unexported}/export`);
    const echo = `${view.submissions[0].digest}`;
    for (const changed of [`${echo}.`, echo.replace('hints', 'hint'), `${echo}\u{200b}`])
      await refused(
        replies,
        content({ binding: { ...reply.binding, submissionId: unexported }, echo: changed }),
        409,
        'reply_not_matched',
      );
  } finally {
    await t.close();
  }
});
