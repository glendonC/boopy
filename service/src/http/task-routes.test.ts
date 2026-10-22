import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { Boopy } from '../boopy.ts';
import type { SessionView } from '../contracts.ts';
import { TaskStore } from '../interaction/tasks.ts';
import { FixtureInterpreter } from '../interpret/fixture.ts';
import type { ModelOutput } from '../interpret/output.ts';
import { Journal } from '../journal.ts';
import type { Segmenter } from '../segmentation.ts';
import { fixtureJpeg, startRequest, testBoopy } from '../testing.ts';
import { headsetApp } from './headset.ts';

const SAID = 'What is this?';
const OPEN = { eventId: 'evt_open_capture', taskId: 'tsk_capture' };
const WAV = Buffer.from('RIFF synthetic answer clip').toString('base64');
const OTHER_WAV = Buffer.from('RIFF another synthetic clip').toString('base64');
const AUDIO = createHash('sha256').update(Buffer.from(WAV, 'base64')).digest('hex');
const ANSWER = 'Two camels and a tent.';
const FRAME = createHash('sha256').update(fixtureJpeg('desert-photo.jpg')).digest('hex');
const ANSWERS = `/v1/tasks/${OPEN.taskId}/answers`;
const ACTIONS = `/v1/tasks/${OPEN.taskId}/actions`;
const NONVISUAL = {
  scope: 'scene' as const,
  evidence: 'none' as const,
  source: 'unknown' as const,
  ambiguousTarget: false,
  ocrRequested: false,
  segmentationRequested: false,
  maxAgeMs: 15000,
};
const TARGETED = {
  scope: 'target' as const,
  evidence: 'visual' as const,
  source: 'current-surroundings' as const,
  ambiguousTarget: false,
  ocrRequested: true,
  segmentationRequested: false,
  maxAgeMs: 15000,
};

/** What the headset sends when the person points at a subject and speaks. */
function capture(said: string) {
  const request = startRequest(said);
  return {
    ...request,
    frame: { ...request.frame, source: 'current-surroundings', timestampTrusted: false },
    cues: {
      ...request.cues,
      pointer: { point: { x: 0.45, y: 0.55 }, onSurface: true, hand: 'right' },
    },
    attention: TARGETED,
  };
}

/** A later talk turn with its own view. */
function followUp(said: string) {
  const { frame, cues, attention } = capture(said);
  return { frame, cues, attention, speech: { text: said } };
}

type Change = (output: ModelOutput) => ModelOutput;

/** A Boopy on the recorded fixture interpretation, a fake recognizer, and no way off the Mac. */
function setup(
  change: Change = (output) => output,
  options: { readonly segmenter?: Segmenter | undefined; readonly recognizer?: false } = {},
) {
  const journal = Journal.open(':memory:');
  const fixture = new FixtureInterpreter();
  let modelCalls = 0;
  const test = testBoopy({
    journal,
    interpreter: {
      provider: fixture.provider,
      model: fixture.model,
      async interpret(input) {
        modelCalls += 1;
        const output = change((await fixture.interpret(input)).output);
        return { output, raw: JSON.stringify(output) };
      },
    },
    ...(options.segmenter === undefined ? {} : { segmenter: options.segmenter }),
  });
  // Speech that is not set up on this Mac: the same service without a recognizer.
  const boopy =
    options.recognizer === false ? new Boopy({ ...test.deps, speech: null }) : test.boopy;
  let transcriptions = 0;
  let gate: Promise<void> | null = null;
  const heard = test.speech.transcribe.bind(test.speech);
  test.speech.transcribe = async () => {
    transcriptions += 1;
    if (gate !== null) await gate;
    return heard();
  };
  test.speech.heard = { text: ANSWER, language: 'en' };
  const realFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async () => {
    requests += 1;
    throw new Error('Nothing leaves the Mac in this test.');
  }) as typeof fetch;
  const tasks = new TaskStore(journal);
  const app = headsetApp(boopy, { logger: false, tasks });
  const post = (url: string, payload: unknown, headers: Record<string, string> = {}) =>
    app.inject({
      method: 'POST',
      url,
      headers: { host: '127.0.0.1', 'content-type': 'application/json', ...headers },
      payload: JSON.stringify(payload),
    });
  const get = (url: string, headers: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url, headers: { host: '127.0.0.1', ...headers } });
  const ctx = {
    journal,
    tasks,
    speech: test.speech,
    post,
    get,
    modelCalls: () => modelCalls,
    transcriptions: () => transcriptions,
    requests: () => requests,
    hold(until: Promise<void> | null) {
      gate = until;
    },
    async start(request: object = capture(SAID)): Promise<SessionView> {
      const response = await post('/v1/sessions', request);
      assert.equal(response.statusCode, 200, response.body);
      return response.json();
    },
    async opened() {
      const session = await ctx.start();
      const response = await post(`/v1/sessions/${session.id}/task`, OPEN);
      assert.equal(response.statusCode, 200, response.body);
      return { session, task: response.json() };
    },
    async close() {
      globalThis.fetch = realFetch;
      await app.close();
      journal.close();
    },
  };
  return ctx;
}

const answer = (
  sessionId: string,
  expectedRevision: number,
  eventId = 'evt_answer_one',
  wav = WAV,
) => ({ eventId, sessionId, expectedRevision, speech: { wav } });

/** The id of an event Boopy itself journaled, which no task event may reuse. */
function boopyEventId(journal: Journal): string {
  const id = journal.all().find((event) => !event.type.startsWith('task.'))?.id;
  if (id === undefined || !/^evt_[A-Za-z0-9_-]+$/.test(id)) throw new Error('No Boopy event id.');
  return id;
}

const resultIdOf = (sessionId: string, utteranceId: string, at: string) =>
  `res_${createHash('sha256').update(`${sessionId}:${utteranceId}:${at}`).digest('hex').slice(0, 32)}`;

describe('open the session task', () => {
  it('opens one task from the first completed visual turn with a labeled local stand-in result', async () => {
    const ctx = setup();
    try {
      const session = await ctx.start();
      const referent = session.items.find((item) => item.id === session.referentId);
      assert.ok(referent && session.dialogue);
      assert.equal(referent.status, 'proposed');
      const before = ctx.journal.all().length;
      const response = await ctx.post(`/v1/sessions/${session.id}/task`, OPEN);
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.headers['cache-control'], 'no-store');
      const view = response.json();
      const observed = ctx.journal.all().find((event) => event.type === 'observation.recorded');
      assert.equal(observed?.type, 'observation.recorded');
      if (observed?.type !== 'observation.recorded') return;
      assert.equal(observed.data.frameSha256, FRAME);
      const source = {
        sourceId: `src_${observed.data.observationId}`,
        sourceRevision: 1,
        sha256: FRAME,
      };
      assert.deepEqual(view.source, source);
      assert.equal(view.utterance, session.utterances[0]?.text);
      assert.equal(view.utterance, SAID);
      assert.equal(view.intent, 'consult_source');
      assert.equal(view.taskId, OPEN.taskId);
      assert.equal(view.sessionId, session.id);
      assert.equal(view.revision, 1);
      assert.equal(view.phase, 'open');
      assert.equal(view.continuity, 'local-only');
      assert.equal(view.delivery, 'not-sent');
      assert.equal(view.subjectCorrected, false);
      assert.deepEqual(view.attempts, []);
      assert.deepEqual(view.components, [
        { type: 'subject', sourceId: source.sourceId, maskId: null },
        { type: 'annotation', text: referent.label, evidenceIds: [referent.id] },
        { type: 'dialogue', text: session.dialogue.text, evidenceIds: [referent.id] },
        { type: 'voice_reply', prompt: 'Answer aloud.' },
        { type: 'status', code: 'not-sent' },
      ]);
      const added = ctx.journal.all().slice(before);
      assert.deepEqual(
        added.map((event) => [event.type, event.actor]),
        [
          ['task.opened', 'system'],
          ['task.provider-accepted', 'system'],
        ],
      );
      const opening = added[0];
      if (opening?.type !== 'task.opened') throw new Error('No opening.');
      assert.equal(opening.data.utterance, SAID);
      const result = added[1];
      assert.equal(result?.type, 'task.provider-accepted');
      if (result?.type !== 'task.provider-accepted') return;
      assert.equal(result.data.simulator, true);
      assert.equal(result.data.baseRevision, 0);
      assert.deepEqual(result.data.evidenceIds, [referent.id]);
      assert.equal(
        result.id,
        resultIdOf(session.id, session.dialogue.utteranceId, session.dialogue.at),
      );
      assert.equal(result.data.resultId, result.id);
      assert.deepEqual((await ctx.get(`/v1/tasks/${OPEN.taskId}`)).json(), view);
      assert.deepEqual((await ctx.get(`/v1/sessions/${session.id}`)).json(), session);
      assert.equal(ctx.modelCalls(), 1);
      assert.equal(ctx.transcriptions(), 0);
      assert.equal(ctx.requests(), 0);
    } finally {
      await ctx.close();
    }
  });

  it('a retry with the same ids or with new ids returns the same task and journals nothing', async () => {
    const ctx = setup();
    try {
      const { session, task } = await ctx.opened();
      const count = ctx.journal.all().length;
      const retry = await ctx.post(`/v1/sessions/${session.id}/task`, OPEN);
      assert.equal(retry.statusCode, 200, retry.body);
      assert.deepEqual(retry.json(), task);
      const other = await ctx.post(`/v1/sessions/${session.id}/task`, {
        eventId: 'evt_open_again',
        taskId: 'tsk_second',
      });
      assert.equal(other.statusCode, 200, other.body);
      assert.deepEqual(other.json(), task);
      assert.equal(ctx.journal.all().length, count);
      assert.equal((await ctx.get('/v1/tasks/tsk_second')).json(), null);
    } finally {
      await ctx.close();
    }
  });

  it('keeps the task on its first turn, and a later reply alone does not open one', async () => {
    const opened = setup();
    try {
      const { session, task } = await opened.opened();
      const later = await opened.post(
        `/v1/sessions/${session.id}/utterances`,
        followUp('What about the tents?'),
      );
      assert.equal(later.statusCode, 200, later.body);
      assert.equal(later.json().observations.length, 2);
      assert.notEqual(later.json().dialogue.utteranceId, session.dialogue?.utteranceId);
      const count = opened.journal.all().length;
      const again = await opened.post(`/v1/sessions/${session.id}/task`, OPEN);
      assert.equal(again.statusCode, 200, again.body);
      assert.deepEqual(again.json(), task);
      assert.equal(opened.journal.all().length, count);
    } finally {
      await opened.close();
    }
    const ctx = setup();
    try {
      const session = await ctx.start();
      const later = await ctx.post(
        `/v1/sessions/${session.id}/utterances`,
        followUp('What about the tents?'),
      );
      assert.equal(later.statusCode, 200, later.body);
      const turn = later.json();
      assert.ok(turn.dialogue && turn.referentId);
      assert.equal(turn.model?.provider, 'fixture');
      const count = ctx.journal.all().length;
      const refused = await ctx.post(`/v1/sessions/${session.id}/task`, OPEN);
      assert.equal(refused.statusCode, 409, refused.body);
      assert.equal(refused.json().error.code, 'task_unavailable');
      assert.equal(ctx.journal.all().length, count);
    } finally {
      await ctx.close();
    }
  });

  it('refuses a session without a task-ready turn and journals nothing', async () => {
    const cases: {
      name: string;
      change?: Change;
      segmenter?: Segmenter;
      request?: object;
      check: (session: SessionView) => void;
    }[] = [
      {
        name: 'a proposal and then a failure on the same turn',
        segmenter: {
          provider: 'meta',
          model: 'sam-3.1',
          // A result that breaks only after the proposal is journaled, so the turn fails late.
          segment: async () => ({
            outcome: 'no-match',
            latencyMs: 0,
            confidence: null,
            get concept(): string {
              throw new Error('Synthetic segmenter failure.');
            },
          }),
        },
        request: { ...capture(SAID), attention: { ...TARGETED, segmentationRequested: true } },
        check: (session) => {
          assert.ok(session.dialogue && session.model && session.referentId);
          assert.equal(session.interpretationFailure?.utteranceId, session.dialogue.utteranceId);
          assert.equal(session.utterances.length, 1);
        },
      },
      {
        name: 'a turn that inspected no view',
        request: { cues: {}, speech: { text: 'My trip felt cold.' }, attention: NONVISUAL },
        check: (session) => {
          assert.ok(session.dialogue);
          assert.equal(session.observations.length, 0);
        },
      },
      {
        name: 'a failed interpretation',
        change: () => {
          throw new Error('Synthetic interpreter failure.');
        },
        check: (session) => {
          assert.ok(session.dialogue);
          assert.equal(session.interpretationFailure?.code, 'interpreter_failed');
        },
      },
      {
        name: 'no selected subject',
        change: (output) => ({ ...output, referent: { ...output.referent, key: null } }),
        check: (session) => {
          assert.ok(session.dialogue && session.model);
          assert.equal(session.referentId, null);
        },
      },
      {
        name: 'a subject not grounded on the view',
        change: (output) => ({
          ...output,
          items: output.items.map((item) =>
            item.key === 'photo' ? { ...item, box: null, scene: true } : item,
          ),
        }),
        check: (session) => {
          assert.ok(session.dialogue && session.model);
          const referent = session.items.find((item) => item.id === session.referentId);
          assert.deepEqual(referent?.grounding, { kind: 'scene' });
        },
      },
      {
        name: 'a start that records no reply',
        request: startRequest(SAID),
        check: (session) => {
          assert.ok(session.model && session.referentId);
          assert.equal(session.dialogue, undefined);
        },
      },
    ];
    for (const item of cases) {
      const ctx = setup(item.change, { segmenter: item.segmenter });
      try {
        const session = await ctx.start(item.request);
        item.check(session);
        const before = ctx.journal.all().length;
        const response = await ctx.post(`/v1/sessions/${session.id}/task`, OPEN);
        assert.equal(response.statusCode, 409, `${item.name}: ${response.body}`);
        assert.equal(response.json().error.code, 'task_unavailable', item.name);
        assert.equal(ctx.journal.all().length, before, item.name);
        assert.equal(ctx.tasks.forSession(session.id), undefined, item.name);
      } finally {
        await ctx.close();
      }
    }
    const ctx = setup();
    try {
      const unknown = await ctx.post('/v1/sessions/ses_missing/task', OPEN);
      assert.equal(unknown.statusCode, 404);
      assert.equal(unknown.json().error.code, 'no_session');
      assert.equal(ctx.journal.all().length, 0);
    } finally {
      await ctx.close();
    }
  });
});
