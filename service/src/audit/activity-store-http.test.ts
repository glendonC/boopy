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
