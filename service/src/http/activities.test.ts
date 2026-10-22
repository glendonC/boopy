import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ActivityStore } from '../activity.ts';
import { ActivityRequestFile, ActivitySubmissionFile, ActivityView } from '../activity-contract.ts';
import { HandoffPreparation } from '../handoff-preparation.ts';
import { startRequest, testBoopy } from '../testing.ts';
import { connectorApp } from './connector.ts';
import { headsetApp } from './headset.ts';

const TOKEN = 'synthetic-activity-route-token';
const authorization = `Bearer ${TOKEN}`;

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'boopy-activity-routes-'));
  const test = testBoopy();
  const session = await test.boopy.start(startRequest('Synthetic camel and tent.'));
  const packageId = test.boopy.commit(session.id).committed?.packageId;
  assert.ok(packageId);
  await writeFile(join(directory, 'connector-token'), TOKEN, { mode: 0o600 });
  let port = 0;
  const preparation = new HandoffPreparation({
    journal: test.journal,
    outputRoot: join(directory, 'handoffs'),
    dataDir: directory,
    get port() {
      return port;
    },
    packageForId: (id) => test.boopy.package(id),
    sessionForId: (id) => test.boopy.view(id),
    supersessions: () => test.boopy.supersessions,
  });
  const activities = new ActivityStore({
    journal: test.journal,
    preparation,
    packageForId: (id) => test.boopy.package(id),
    supersessions: () => test.boopy.supersessions,
  });
  const connector = connectorApp(test.boopy, {
    token: TOKEN,
    baseUrl: 'https://fictional.example',
    logger: false,
    handoff: preparation,
    activities,
  });
  await connector.listen({ host: '127.0.0.1', port: 0 });
  port = (connector.server.address() as AddressInfo).port;
  const headset = headsetApp(test.boopy, { logger: false, handoff: preparation, activities });
  await preparation.prepare(session.id, { requestId: 'synthetic-preparation-1', packageId });
  const local = (url: string, payload?: unknown, headers: Record<string, string> = {}) =>
    connector.inject({
      method: 'POST',
      url,
      remoteAddress: '127.0.0.1',
      headers: { host: '127.0.0.1', authorization, ...headers },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  const native = (method: 'GET' | 'POST', url: string, payload?: unknown, headers = {}) =>
    headset.inject({
      method,
      url,
      headers: { host: '127.0.0.1', ...headers },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  return {
    ...test,
    directory,
    sessionId: session.id,
    packageId,
    connector,
    headset,
    local,
    native,
    async close() {
      connector.server.closeAllConnections();
      await connector.close();
      await headset.close();
      test.journal.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

type Setup = Awaited<ReturnType<typeof setup>>;

function activityFile(request: ReturnType<typeof ActivityRequestFile.parse>) {
  const camel = request.sources.find((source) => source.label === 'Camels')?.sourceId ?? null;
  return JSON.stringify({
    ...request.respondWith,
    author: 'Grok Bot',
    fallbackText: 'Picture the camel to the left of the tent and say it in Korean.',
    activity: {
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
            { key: 'a', label: { text: '낙타', language: 'ko', gloss: 'camel' }, sourceId: camel },
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
          ],
        },
      ],
      hints: [{ text: 'Start with the camel, then say where it is.', language: 'en' }],
    },
  });
}

/** Request and import through the local routes; returns the request file and activity ID. */
async function imported(test: Setup) {
  const response = await test.local('/v1/local-activities/requests', {
    packageId: test.packageId,
    goal: 'Practice saying where things are in Korean.',
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.headers['cache-control'], 'no-store');
  const request = ActivityRequestFile.parse(JSON.parse(response.json().file));
  const result = await test.local('/v1/local-activities/imports', {
    content: activityFile(request),
  });
  assert.equal(result.statusCode, 200, result.body);
  return { request, activityId: result.json().activityId as string };
}

const journaled = (test: Setup) => test.journal.all().length;

describe('activity routes', () => {
  it('run the whole loop over HTTP: request, import, changes, submit, export, reply, next', async () => {
    const test = await setup();
    try {
      const health = (await test.native('GET', '/v1/health')).json();
      assert.equal(health.activities, true);
      const { request, activityId } = await imported(test);
      const listing = await test.native('GET', '/v1/activities');
      assert.equal(listing.statusCode, 200);
      assert.equal(listing.headers['cache-control'], 'no-store');
      assert.deepEqual(
        listing.json().activities.map((entry: { activityId: string }) => entry.activityId),
        [activityId],
      );
      const base = `/v1/activities/${activityId}`;
      let view = (await test.native('GET', base)).json();
      assert.equal(ActivityView.parse(view).revision, 0);
      view = (
        await test.native('POST', `${base}/arrangement`, {
          revision: 0,
          positions: { a: 0.22, b: 0.71 },
        })
      ).json();
      assert.equal(view.revision, 1);
      view = (
        await test.native('POST', `${base}/sequence`, {
          revision: 1,
          chosen: ['t2', 't4', 't3', 't1'],
        })
      ).json();
      view = (await test.native('POST', `${base}/hints`, { revision: 2 })).json();
      assert.equal(view.hints.revealed.length, 1);
      const submitted = await test.native('POST', `${base}/submissions`, { revision: 3 });
      assert.equal(submitted.statusCode, 200);
      const submission = ActivityView.parse(submitted.json()).submissions[0];
      assert.ok(submission);
      assert.equal(submission.export, null);
      const exported = await test.local(
        `/v1/local-activities/submissions/${submission.submissionId}/export`,
      );
      assert.equal(exported.statusCode, 200, exported.body);
      assert.equal(exported.headers['x-content-type-options'], 'nosniff');
      const body = exported.json();
      assert.equal(body.submissionId, submission.submissionId);
      assert.equal(body.fileName, `boopy-activity-submission-${submission.submissionId}.json`);
      const file = ActivitySubmissionFile.parse(JSON.parse(body.file));
      assert.equal(file.digest, submission.digest);
      const again = await test.local(
        `/v1/local-activities/submissions/${submission.submissionId}/export`,
      );
      assert.equal(again.json().file, body.file);
      const reply = await test.local('/v1/local-activities/replies', {
        content: JSON.stringify({
          ...file.respondWith,
          author: 'Grok Bot',
          reply: {
            summary: { text: 'Synthetic example reply for rendering tests.', language: 'en' },
            points: [
              { about: 'sequence', text: 'Synthetic point about the sentence.', language: 'en' },
            ],
          },
          next: {
            fallbackText: 'Now put the tent to the left of the camel.',
            activity: JSON.parse(activityFile(request)).activity,
          },
        }),
      });
      assert.equal(reply.statusCode, 200, reply.body);
      const result = reply.json();
      assert.equal(result.duplicate, false);
      assert.equal(result.nextStatus, 'active');
      const next = await test.native('GET', `/v1/activities/${result.nextActivityId}`);
      assert.equal(next.statusCode, 200);
      assert.deepEqual(ActivityView.parse(next.json()).provenance.parent, {
        activityId,
        submissionId: submission.submissionId,
        replyId: result.replyId,
      });
      for (const response of [listing, next, submitted]) {
        assert.equal(response.body.includes(test.directory), false);
        assert.equal(response.body.includes(TOKEN), false);
        assert.equal(response.body.includes('Nothing has been sent to Muse'), false);
      }
    } finally {
      await test.close();
    }
  });

  it('refuse any Origin and a non-loopback Host on headset routes, with nothing journaled', async () => {
    const test = await setup();
    try {
      const { activityId } = await imported(test);
      const before = journaled(test);
      const base = `/v1/activities/${activityId}`;
      for (const origin of ['http://localhost', 'null', '', 'https://fictional.example'])
        for (const [method, url, payload] of [
          ['GET', '/v1/activities', undefined],
          ['GET', base, undefined],
          ['POST', `${base}/arrangement`, { revision: 0, positions: { a: 0.1, b: 0.9 } }],
          ['POST', `${base}/sequence`, { revision: 0, chosen: ['t1'] }],
          ['POST', `${base}/hints`, { revision: 0 }],
          ['POST', `${base}/submissions`, { revision: 0 }],
        ] as const) {
          const response = await test.native(method, url, payload, { origin });
          assert.equal(response.statusCode, 403, `${method} ${url} ${origin}`);
          assert.equal(response.json().error.code, 'browser_not_allowed');
        }
      const foreign = await test.headset.inject({
        method: 'GET',
        url: '/v1/activities',
        headers: { host: 'fictional.example' },
      });
      assert.equal(foreign.statusCode, 403);
      assert.equal(journaled(test), before);
    } finally {
      await test.close();
    }
  });

  it('map refusals to the contract codes with nothing journaled', async () => {
    const test = await setup();
    try {
      const { activityId } = await imported(test);
      const before = journaled(test);
      const base = `/v1/activities/${activityId}`;
      const encoded = `/v1/activities/${activityId.replace('_', '%5F')}`;
      for (const [method, url, payload, status, code] of [
        ['GET', '/v1/activities/act_unknown', undefined, 404, 'activity_unknown'],
        ['GET', encoded, undefined, 404, 'activity_unknown'],
        ['POST', `${encoded}/hints`, { revision: 0 }, 404, 'activity_unknown'],
        ['GET', `/v1/activities/%20${activityId}`, undefined, 404, 'activity_unknown'],
        ['POST', `${base}/hints`, { revision: 5 }, 409, 'stale_activity'],
        ['POST', `${base}/submissions`, { revision: 0 }, 409, 'nothing_to_submit'],
        ['POST', `${base}/hints`, { revision: '0' }, 400, 'invalid_request'],
        [
          'POST',
          `${base}/arrangement`,
          { revision: 0, positions: { a: 0.1 } },
          400,
          'invalid_request',
        ],
        ['POST', `${base}/sequence`, { revision: 0, chosen: ['t9'] }, 400, 'invalid_request'],
        ['POST', `${base}/sequence`, { revision: 0, chosen: ['t1', 't1'] }, 400, 'invalid_request'],
      ] as const) {
        const response = await test.native(method, url, payload);
        assert.equal(response.statusCode, status, `${method} ${url} ${response.body}`);
        assert.equal(response.json().error.code, code, response.body);
      }
      const proto = await test.headset.inject({
        method: 'POST',
        url: `${base}/arrangement`,
        headers: { host: '127.0.0.1', 'content-type': 'application/json' },
        payload: '{"revision":0,"positions":{"a":0.1,"b":0.2,"__proto__":0.3}}',
      });
      assert.equal(proto.statusCode, 400);
      const notJson = await test.headset.inject({
        method: 'POST',
        url: `${base}/hints`,
        headers: { host: '127.0.0.1', 'content-type': 'application/json' },
        payload: '{"revision":',
      });
      assert.equal(notJson.statusCode, 400);
      await test.native('POST', `${base}/hints`, { revision: 0 });
      const none = await test.native('POST', `${base}/hints`, { revision: 1 });
      assert.equal(none.statusCode, 409);
      assert.equal(none.json().error.code, 'no_more_hints');
      assert.equal(journaled(test), before + 1);
      const fallback = await test.local('/v1/local-activities/imports', {
        content: JSON.stringify({
          ...JSON.parse(activityFile((await imported(test)).request)),
          activity: { title: 'Unsupported', components: [{ type: 'map' }] },
        }),
      });
      assert.equal(fallback.json().status, 'fallback-only');
      const unavailable = await test.native(
        'POST',
        `/v1/activities/${fallback.json().activityId}/hints`,
        { revision: 0 },
      );
      assert.equal(unavailable.statusCode, 409);
      assert.equal(unavailable.json().error.code, 'activity_unavailable');
    } finally {
      await test.close();
    }
  });

  it('return import issues and file refusals from the local routes, with nothing journaled', async () => {
    const test = await setup();
    try {
      const { request } = await imported(test);
      const before = journaled(test);
      const valid = JSON.parse(activityFile(request));
      for (const [content, status, code] of [
        ['not json', 400, 'activity_unreadable'],
        [`{"pad":"${'a'.repeat(70_000)}"}`, 400, 'activity_unreadable'],
        [
          JSON.stringify({ ...valid, binding: { ...valid.binding, packetSha256: '2'.repeat(64) } }),
          409,
          'activity_binding_mismatch',
        ],
      ] as const) {
        const response = await test.local('/v1/local-activities/imports', { content });
        assert.equal(response.statusCode, status, response.body);
        assert.equal(response.json().error.code, code);
      }
      const invalid = await test.local('/v1/local-activities/imports', {
        content: JSON.stringify({ ...valid, author: '<b>Grok</b>', extra: 1 }),
      });
      assert.equal(invalid.statusCode, 400);
      assert.deepEqual(invalid.json().error.issues, [
        'author: Use plain text without markup.',
        'file: Remove the unsupported field "extra".',
      ]);
      assert.equal(invalid.json().error.code, 'activity_invalid');
      for (const payload of [{}, { content: 1 }, { content: 'x', extra: 1 }]) {
        const response = await test.local('/v1/local-activities/imports', payload);
        assert.equal(response.statusCode, 400);
        assert.equal(response.json().error.code, 'invalid_request');
      }
      const duplicate = await test.local('/v1/local-activities/imports', {
        content: activityFile(request),
      });
      assert.equal(duplicate.json().duplicate, true);
      for (const [url, payload, status, code] of [
        [
          '/v1/local-activities/submissions/sub_unknown/export',
          undefined,
          404,
          'submission_unknown',
        ],
        ['/v1/local-activities/replies', { content: '[]' }, 400, 'activity_unreadable'],
        [
          '/v1/local-activities/requests',
          { packageId: 'ctx_unknown', goal: 'Practice.' },
          404,
          'prepared_unavailable',
        ],
      ] as const) {
        const response = await test.local(url, payload);
        assert.equal(response.statusCode, status, response.body);
        assert.equal(response.json().error.code, code);
      }
      assert.equal(journaled(test), before);
    } finally {
      await test.close();
    }
  });

  it('keep the local routes behind the token and the local-only checks, out of OpenAPI', async () => {
    const test = await setup();
    try {
      const { request } = await imported(test);
      const before = journaled(test);
      const routes: [string, unknown][] = [
        ['/v1/local-activities/requests', { packageId: test.packageId, goal: 'Practice.' }],
        ['/v1/local-activities/imports', { content: activityFile(request) }],
        ['/v1/local-activities/submissions/sub_unknown/export', undefined],
        ['/v1/local-activities/replies', { content: '{}' }],
      ];
      for (const [url, payload] of routes) {
        for (const [headers, remoteAddress, expected] of [
          [{ authorization: '' }, '127.0.0.1', 401],
          [{ authorization: `Bearer ${'x'.repeat(TOKEN.length)}` }, '127.0.0.1', 401],
          [{ host: 'fictional.example' }, '127.0.0.1', 403],
          [{ origin: 'http://localhost' }, '127.0.0.1', 403],
          [{ origin: 'null' }, '127.0.0.1', 403],
          [{ forwarded: 'for=127.0.0.1' }, '127.0.0.1', 403],
          [{ 'x-forwarded-for': '127.0.0.1' }, '127.0.0.1', 403],
          [{ 'x-real-ip': '127.0.0.1' }, '127.0.0.1', 403],
          [{}, '192.0.2.1', 403],
        ] as const) {
          const response = await test.connector.inject({
            method: 'POST',
            url,
            remoteAddress,
            headers: { host: '127.0.0.1', authorization, ...headers },
            ...(payload === undefined ? {} : { payload: payload as object }),
          });
          assert.equal(response.statusCode, expected, `${url} ${JSON.stringify(headers)}`);
        }
        const encoded = await test.connector.inject({
          method: 'POST',
          url: url.replace('local-activities', 'local%2Dactivities'),
          remoteAddress: '127.0.0.1',
          headers: { host: '127.0.0.1' },
          ...(payload === undefined ? {} : { payload: payload as object }),
        });
        assert.ok([401, 404].includes(encoded.statusCode), `${encoded.statusCode} ${url}`);
      }
      assert.equal(journaled(test), before);
      const openapi = await test.connector.inject({
        url: '/openapi.json',
        headers: { host: '127.0.0.1' },
      });
      assert.equal(openapi.body.includes('local-activities'), false);
    } finally {
      await test.close();
    }
  });
});
