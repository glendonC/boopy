import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TaskStore } from '../interaction/tasks.ts';
import { Journal } from '../journal.ts';
import { testBoopy } from '../testing.ts';
import { headsetApp } from './headset.ts';

const AT = '1970-01-01T00:00:00.000Z';
const SHA = 'a'.repeat(64);
const SOURCE = { sourceId: 'src_sahara_still', sourceRevision: 1, sha256: SHA };
const SESSION = 'sess_owner';
const TASK = 'tsk_sahara_later';
const UTTERANCE = 'Sahara. Save it. Korean later.';

function setup() {
  const journal = Journal.open(':memory:');
  let modelCalls = 0;
  const test = testBoopy({
    journal,
    interpreter: {
      provider: 'fixture',
      model: 'must-not-run',
      interpret: async () => {
        modelCalls += 1;
        throw new Error('The task read must not invent a reply.');
      },
    },
  });
  const tasks = new TaskStore(journal);
  const app = headsetApp(test.boopy, { logger: false, tasks });
  const call = (
    method: 'GET' | 'POST',
    url: string,
    payload?: object | string,
    headers: Record<string, string> = {},
  ) =>
    app.inject({
      method,
      url,
      headers: {
        host: '127.0.0.1',
        ...(payload === undefined
          ? {}
          : {
              'content-type':
                typeof payload === 'string'
                  ? 'application/x-www-form-urlencoded'
                  : 'application/json',
            }),
        ...headers,
      },
      ...(payload === undefined ? {} : { payload }),
    });
  return {
    journal,
    tasks,
    modelCalls: () => modelCalls,
    get: (url: string, payload?: object | string, headers?: Record<string, string>) =>
      call('GET', url, payload, headers),
    post: (url: string, payload?: object | string) => call('POST', url, payload),
    async close() {
      await app.close();
      journal.close();
    },
  };
}

function openSahara(tasks: TaskStore) {
  return tasks.open(
    {
      eventId: 'evt_open_sahara',
      sessionId: SESSION,
      taskId: TASK,
      source: SOURCE,
      intent: 'continue_saved_task',
      utterance: UTTERANCE,
    },
    AT,
  );
}

describe('task view route', () => {
  it('an empty store returns an empty result and not a lesson', async () => {
    const ctx = setup();
    try {
      const response = await ctx.get(`/v1/tasks/${TASK}`);
      assert.equal(response.statusCode, 200);
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.equal(response.json(), null);
      assert.equal(response.body.includes(UTTERANCE), false);
      assert.doesNotMatch(response.body, /dialogue|voice_reply|이 사진|lesson|grok-bot/);
      const asked = await ctx.get(`/v1/tasks/${TASK}`, {
        utterance: UTTERANCE,
        components: [
          { type: 'dialogue', text: '이 사진에 뭐가 있어요?', evidenceIds: ['ev_camel'] },
        ],
      });
      assert.equal(asked.statusCode, 200, asked.body);
      assert.equal(asked.json(), null);
      assert.equal(asked.body.includes(UTTERANCE), false);
      const refused = await ctx.get(`/v1/tasks/${TASK}?continuity=grok-bot`);
      assert.equal(refused.statusCode, 400);
      assert.equal(refused.json().error.code, 'continuity_refused');
      assert.equal(refused.body.includes(UTTERANCE), false);
      assert.equal(ctx.journal.all().length, 0);
      assert.equal(ctx.modelCalls(), 0);
      const foreign = await ctx.get(`/v1/tasks/${TASK}`, undefined, { host: 'evil.example' });
      assert.equal(foreign.statusCode, 403);
      assert.equal(foreign.json().error.code, 'forbidden_host');
    } finally {
      await ctx.close();
    }
  });

  it('a saved Sahara request is readable and does not gain a lesson', async () => {
    const ctx = setup();
    try {
      const opened = openSahara(ctx.tasks);
      assert.equal(opened.status, 'accepted');
      if (opened.status !== 'accepted') return;
      const before = ctx.journal.all().length;
      const response = await ctx.get(`/v1/tasks/${TASK}`);
      assert.equal(response.statusCode, 200);
      assert.equal(response.headers['cache-control'], 'no-store');
      const view = response.json();
      assert.equal(view.utterance, UTTERANCE);
      assert.equal(view.continuity, 'local-only');
      assert.equal(view.delivery, 'not-sent');
      assert.equal(view.revision, 0);
      assert.deepEqual(view.components, [{ type: 'status', code: 'not-sent' }]);
      assert.deepEqual(view.attempts, []);
      assert.deepEqual(view, opened.task);
      const pushed = await ctx.get(`/v1/tasks/${TASK}?continuity=local-only&delivery=not-sent`, {
        utterance: UTTERANCE,
        continuity: 'local-only',
        delivery: 'not-sent',
        components: [
          { type: 'dialogue', text: '이 사진에 뭐가 있어요?', evidenceIds: ['ev_camel'] },
        ],
      });
      assert.equal(pushed.statusCode, 200, pushed.body);
      assert.deepEqual(pushed.json(), opened.task);
      const encoded = await ctx.get(`/v1/tasks/${TASK.replaceAll('_', '%5F')}`);
      assert.equal(encoded.statusCode, 200);
      assert.equal(encoded.json(), null);
      const posted = await ctx.post(`/v1/tasks/${TASK}`, {
        utterance: UTTERANCE,
        delivery: 'sent',
        continuity: 'grok-bot',
      });
      assert.equal(posted.statusCode, 404);
      const webhook = await ctx.post('/v1/webhooks/tasks', {
        utterance: UTTERANCE,
        delivery: 'sent',
      });
      assert.equal(webhook.statusCode, 404);
      assert.equal(ctx.journal.all().length, before);
      assert.deepEqual(ctx.tasks.get(TASK), opened.task);
      assert.equal(ctx.modelCalls(), 0);
    } finally {
      await ctx.close();
    }
  });

  it('a stored provider result stays local-only and not-sent', async () => {
    const ctx = setup();
    try {
      const labelSource = { ...SOURCE, sourceId: 'src_device_label' };
      const opened = ctx.tasks.open(
        {
          eventId: 'evt_open_manual',
          sessionId: SESSION,
          taskId: 'tsk_manual',
          source: labelSource,
          intent: 'consult_source',
          utterance: 'What does this label say?',
        },
        AT,
      );
      assert.equal(opened.status, 'accepted');
      const received = ctx.tasks.receive(
        {
          resultId: 'res_manual',
          sessionId: SESSION,
          taskId: 'tsk_manual',
          baseRevision: 0,
          source: labelSource,
          evidenceIds: ['ev_label'],
          components: [
            { type: 'subject', sourceId: 'src_device_label', maskId: null },
            { type: 'annotation', text: 'Label', evidenceIds: ['ev_label'] },
            { type: 'dialogue', text: 'The label is unread.', evidenceIds: ['ev_label'] },
            {
              type: 'choice',
              prompt: 'Read it again?',
              options: [{ id: 'opt_retry', label: 'Try again' }],
            },
          ],
        },
        AT,
      );
      assert.equal(received.status, 'accepted');
      if (received.status !== 'accepted') return;
      const before = ctx.journal.all().length;
      const missing = await ctx.get(`/v1/tasks/${TASK}`, { utterance: UTTERANCE });
      assert.equal(missing.statusCode, 200);
      assert.equal(missing.json(), null);
      const response = await ctx.get('/v1/tasks/tsk_manual');
      assert.equal(response.statusCode, 200);
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.deepEqual(response.json(), received.task);
      assert.equal(response.json().continuity, 'local-only');
      assert.equal(response.json().delivery, 'not-sent');
      assert.equal(response.body.includes(UTTERANCE), false);
      assert.equal(response.body.includes('grok-bot'), false);
      assert.equal(ctx.journal.all().length, before);
      assert.equal(ctx.modelCalls(), 0);
    } finally {
      await ctx.close();
    }
  });

  it('refuses a query or body that sets continuity to grok-bot or delivery to sent', async () => {
    const ctx = setup();
    try {
      const opened = openSahara(ctx.tasks);
      assert.equal(opened.status, 'accepted');
      if (opened.status !== 'accepted') return;
      const before = ctx.journal.all().length;
      const cases: { url: string; payload?: object | string; code: string }[] = [
        { url: `/v1/tasks/${TASK}?continuity=grok-bot`, code: 'continuity_refused' },
        { url: `/v1/tasks/${TASK}?delivery=sent`, code: 'delivery_refused' },
        { url: `/v1/tasks/${TASK}?delivery=sent&continuity=grok-bot`, code: 'continuity_refused' },
        { url: `/v1/tasks/${TASK}?task[delivery]=sent`, code: 'delivery_refused' },
        {
          url: `/v1/tasks/${TASK}`,
          payload: { continuity: 'grok-bot' },
          code: 'continuity_refused',
        },
        { url: `/v1/tasks/${TASK}`, payload: { delivery: 'sent' }, code: 'delivery_refused' },
        { url: `/v1/tasks/${TASK}`, payload: 'continuity=grok-bot', code: 'continuity_refused' },
        {
          url: `/v1/tasks/${TASK}`,
          payload: { task: { delivery: 'sent' }, utterance: UTTERANCE },
          code: 'delivery_refused',
        },
        {
          url: `/v1/tasks/${TASK}?delivery=sent`,
          payload: { continuity: 'grok-bot', utterance: UTTERANCE },
          code: 'continuity_refused',
        },
      ];
      for (const item of cases) {
        const response = await ctx.get(item.url, item.payload);
        assert.equal(response.statusCode, 400, `${item.url} ${response.body}`);
        assert.equal(response.headers['cache-control'], 'no-store');
        assert.equal(response.json().error.code, item.code);
        assert.equal(response.json().taskId, undefined);
        assert.equal(response.json().continuity, undefined);
        assert.equal(response.json().delivery, undefined);
        assert.equal(response.body.includes(UTTERANCE), false);
        assert.equal(response.body.includes('grok-bot'), false);
        assert.doesNotMatch(response.body, /dialogue|이 사진|lesson/);
      }
      const response = await ctx.get(`/v1/tasks/${TASK}`);
      assert.deepEqual(response.json(), opened.task);
      assert.equal(ctx.journal.all().length, before);
      assert.equal(ctx.modelCalls(), 0);
    } finally {
      await ctx.close();
    }
  });
});
