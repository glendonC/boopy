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
    text: test.text,
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

  it('omits an over-long label or reply instead of shortening it', async () => {
    const label = 'Desert photo '.repeat(7).trim();
    const reply = 'The photo shows dunes. '.repeat(10).trim();
    const cases: [string, Change, string[]][] = [
      [
        'label',
        (output) => ({
          ...output,
          items: output.items.map((item) => (item.key === 'photo' ? { ...item, label } : item)),
        }),
        ['subject', 'dialogue', 'voice_reply', 'status'],
      ],
      [
        'reply',
        (output) => ({ ...output, response: reply }),
        ['subject', 'annotation', 'voice_reply', 'status'],
      ],
    ];
    for (const [name, change, types] of cases) {
      const ctx = setup(change);
      try {
        const session = await ctx.start();
        const referent = session.items.find((item) => item.id === session.referentId);
        if (name === 'label') assert.equal(referent?.label, label);
        else assert.equal(session.dialogue?.text, reply);
        const response = await ctx.post(`/v1/sessions/${session.id}/task`, OPEN);
        assert.equal(response.statusCode, 200, response.body);
        assert.deepEqual(
          response.json().components.map((component: { type: string }) => component.type),
          types,
          name,
        );
        assert.equal(response.body.includes(label.slice(0, 40)), false, name);
        assert.equal(response.body.includes(reply.slice(0, 40)), false, name);
      } finally {
        await ctx.close();
      }
    }
  });

  it('refuses ids that already name another task or journal event, and journals nothing', async () => {
    const ctx = setup();
    try {
      await ctx.opened();
      const other = await ctx.start();
      const before = ctx.journal.all().length;
      const taken = boopyEventId(ctx.journal);
      const cases: [object, string][] = [
        [{ eventId: OPEN.eventId, taskId: 'tsk_other' }, 'duplicate_conflict'],
        [{ eventId: taken, taskId: 'tsk_other' }, 'duplicate_conflict'],
        [{ eventId: 'evt_open_other', taskId: OPEN.taskId }, 'task_exists'],
      ];
      for (const [body, code] of cases) {
        const response = await ctx.post(`/v1/sessions/${other.id}/task`, body);
        assert.equal(response.statusCode, 409, response.body);
        assert.equal(response.json().error.code, code);
      }
      assert.equal(ctx.journal.all().length, before);
      assert.equal(ctx.tasks.forSession(other.id), undefined);
      const own = await ctx.post(`/v1/sessions/${other.id}/task`, {
        eventId: 'evt_open_other',
        taskId: 'tsk_other',
      });
      assert.equal(own.statusCode, 200, own.body);
      assert.equal(own.json().sessionId, other.id);
    } finally {
      await ctx.close();
    }
  });

  it('finishes a task opened without its result, then journals nothing more', async () => {
    const ctx = setup();
    try {
      const session = await ctx.start();
      const observed = ctx.journal.all().find((event) => event.type === 'observation.recorded');
      if (observed?.type !== 'observation.recorded') throw new Error('No observation.');
      const half = ctx.tasks.open(
        {
          ...OPEN,
          sessionId: session.id,
          source: {
            sourceId: `src_${observed.data.observationId}`,
            sourceRevision: 1,
            sha256: FRAME,
          },
          intent: 'consult_source',
          utterance: SAID,
        },
        '1970-01-01T18:00:30.000Z',
      );
      assert.equal(half.status, 'accepted');
      const before = ctx.journal.all().length;
      const response = await ctx.post(`/v1/sessions/${session.id}/task`, OPEN);
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().revision, 1);
      assert.equal(response.json().components.length, 5);
      assert.deepEqual(
        ctx.journal
          .all()
          .slice(before)
          .map((event) => event.type),
        ['task.provider-accepted'],
      );
      const retry = await ctx.post(`/v1/sessions/${session.id}/task`, OPEN);
      assert.deepEqual(retry.json(), response.json());
      assert.equal(ctx.journal.all().length, before + 1);
    } finally {
      await ctx.close();
    }
  });

  it('never serves a task still at revision 0 that this turn cannot finish', async () => {
    const opening = (sessionId: string, sourceId: string, utterance: string) => ({
      ...OPEN,
      sessionId,
      source: { sourceId, sourceRevision: 1, sha256: FRAME },
      intent: 'consult_source',
      utterance,
    });
    const unready = setup((output) => ({ ...output, referent: { ...output.referent, key: null } }));
    try {
      const session = await unready.start();
      assert.equal(session.referentId, null);
      const opened = unready.tasks.open(
        opening(session.id, 'src_elsewhere', SAID),
        '1970-01-01T18:00:30.000Z',
      );
      assert.equal(opened.status, 'accepted');
      const before = unready.journal.all().length;
      const response = await unready.post(`/v1/sessions/${session.id}/task`, OPEN);
      assert.equal(response.statusCode, 409, response.body);
      assert.equal(response.json().error.code, 'task_unavailable');
      assert.equal(unready.journal.all().length, before);
    } finally {
      await unready.close();
    }
    const ctx = setup();
    try {
      const session = await ctx.start();
      const observed = ctx.journal.all().find((event) => event.type === 'observation.recorded');
      if (observed?.type !== 'observation.recorded') throw new Error('No observation.');
      const sourceId = `src_${observed.data.observationId}`;
      const opened = ctx.tasks.open(
        opening(session.id, sourceId, 'Another turn.'),
        '1970-01-01T18:00:30.000Z',
      );
      assert.equal(opened.status, 'accepted');
      const before = ctx.journal.all().length;
      const response = await ctx.post(`/v1/sessions/${session.id}/task`, OPEN);
      assert.equal(response.statusCode, 409, response.body);
      assert.equal(response.json().error.code, 'task_unavailable');
      assert.equal(ctx.journal.all().length, before);
      assert.equal(ctx.tasks.get(OPEN.taskId)?.revision, 0);
    } finally {
      await ctx.close();
    }
  });

  it('a failure on the second append leaves no task, and the next call opens it', async () => {
    const ctx = setup();
    try {
      const session = await ctx.start();
      const before = ctx.journal.all().length;
      const append = ctx.journal.append.bind(ctx.journal);
      ctx.journal.append = (event, id, at) => {
        if (event.type === 'task.provider-accepted') throw new Error('Synthetic disk failure.');
        return append(event, id, at);
      };
      const failed = await ctx.post(`/v1/sessions/${session.id}/task`, OPEN);
      assert.equal(failed.statusCode, 500, failed.body);
      assert.equal(failed.json().error.code, 'internal');
      assert.equal(failed.body.includes('Synthetic'), false);
      assert.equal(ctx.journal.all().length, before);
      assert.equal(ctx.tasks.forSession(session.id), undefined);
      ctx.journal.append = append;
      const opened = await ctx.post(`/v1/sessions/${session.id}/task`, OPEN);
      assert.equal(opened.statusCode, 200, opened.body);
      assert.equal(opened.json().revision, 1);
      assert.equal(ctx.journal.all().length, before + 2);
    } finally {
      await ctx.close();
    }
  });
});

describe('answer a task aloud', () => {
  it('records the transcript as an uncertain practice attempt that stays local and not sent', async () => {
    const ctx = setup();
    try {
      const { session, task } = await ctx.opened();
      const before = ctx.journal.all().length;
      const response = await ctx.post(ANSWERS, answer(session.id, 1));
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.headers['cache-control'], 'no-store');
      const view = response.json();
      assert.equal(view.revision, 2);
      assert.deepEqual(view.attempts, [
        {
          eventId: 'evt_answer_one',
          text: ANSWER,
          recognitionUncertain: true,
          kind: 'practice-attempt',
        },
      ]);
      assert.deepEqual(view.components, task.components);
      assert.deepEqual(view.components.at(-1), { type: 'status', code: 'not-sent' });
      assert.deepEqual(view.source, task.source);
      assert.equal(view.utterance, task.utterance);
      assert.equal(view.continuity, 'local-only');
      assert.equal(view.delivery, 'not-sent');
      const added = ctx.journal.all().slice(before);
      assert.deepEqual(
        added.map((event) => [event.type, event.actor]),
        [['task.action-accepted', 'person']],
      );
      const recorded = added[0];
      if (recorded?.type !== 'task.action-accepted') throw new Error('No recorded answer.');
      assert.deepEqual(recorded.data.action, {
        type: 'voice_reply',
        text: ANSWER,
        recognitionUncertain: true,
        audioSha256: AUDIO,
        recognizer: 'fake speech',
      });
      assert.deepEqual((await ctx.get(`/v1/sessions/${session.id}`)).json(), session);
      assert.equal(ctx.transcriptions(), 1);
      assert.equal(ctx.modelCalls(), 1);
      assert.equal(ctx.requests(), 0);
    } finally {
      await ctx.close();
    }
  });

  it('an empty transcript has no words and journals nothing', async () => {
    const ctx = setup();
    try {
      const { session, task } = await ctx.opened();
      const before = ctx.journal.all().length;
      for (const text of ['', '   ']) {
        ctx.speech.heard = { text, language: 'en' };
        const response = await ctx.post(ANSWERS, answer(session.id, 1));
        assert.equal(response.statusCode, 422, response.body);
        assert.equal(response.json().error.code, 'no_words');
      }
      assert.equal(ctx.journal.all().length, before);
      assert.deepEqual((await ctx.get(`/v1/tasks/${OPEN.taskId}`)).json(), task);
    } finally {
      await ctx.close();
    }
  });

  it('an answer that is not one line of at most 400 characters is refused and journals nothing', async () => {
    const ctx = setup();
    try {
      const { session, task } = await ctx.opened();
      const before = ctx.journal.all().length;
      for (const text of ['a'.repeat(401), 'One line.\nTwo lines.']) {
        ctx.speech.heard = { text, language: 'en' };
        const response = await ctx.post(ANSWERS, answer(session.id, 1));
        assert.equal(response.statusCode, 422, response.body);
        assert.equal(response.json().error.code, 'answer_unusable');
      }
      assert.equal(ctx.transcriptions(), 2);
      assert.equal(ctx.journal.all().length, before);
      assert.deepEqual((await ctx.get(`/v1/tasks/${OPEN.taskId}`)).json(), task);
    } finally {
      await ctx.close();
    }
  });

  it('without a recognizer on this Mac an answer is refused and journals nothing', async () => {
    const ctx = setup(undefined, { recognizer: false });
    try {
      const { session, task } = await ctx.opened();
      const before = ctx.journal.all().length;
      const response = await ctx.post(ANSWERS, answer(session.id, 1));
      assert.equal(response.statusCode, 503, response.body);
      assert.equal(response.json().error.code, 'recognizer_unavailable');
      assert.equal(ctx.transcriptions(), 0);
      assert.equal(ctx.journal.all().length, before);
      assert.deepEqual((await ctx.get(`/v1/tasks/${OPEN.taskId}`)).json(), task);
    } finally {
      await ctx.close();
    }
  });

  it('a stale revision is refused before transcribing, and the task and journal do not change', async () => {
    const ctx = setup();
    try {
      const { session, task } = await ctx.opened();
      const before = ctx.journal.all().length;
      for (const [eventId, expectedRevision] of [
        ['evt_answer_old', 0],
        ['evt_answer_ahead', 5],
      ] as const) {
        const response = await ctx.post(ANSWERS, answer(session.id, expectedRevision, eventId));
        assert.equal(response.statusCode, 409, response.body);
        assert.equal(response.json().error.code, 'stale_revision');
        assert.deepEqual((await ctx.get(`/v1/tasks/${OPEN.taskId}`)).json(), task);
      }
      assert.equal(ctx.transcriptions(), 0);
      assert.equal(ctx.journal.all().length, before);
    } finally {
      await ctx.close();
    }
  });

  it('a retry with the same event id returns the first outcome without transcribing again', async () => {
    const ctx = setup();
    try {
      const { session } = await ctx.opened();
      const first = await ctx.post(ANSWERS, answer(session.id, 1));
      assert.equal(first.statusCode, 200, first.body);
      const count = ctx.journal.all().length;
      ctx.speech.heard = { text: 'Something else entirely.', language: 'en' };
      const retry = await ctx.post(ANSWERS, answer(session.id, 1));
      assert.equal(retry.statusCode, 200, retry.body);
      assert.deepEqual(retry.json(), first.json());
      const conflict = await ctx.post(ANSWERS, answer(session.id, 2));
      assert.equal(conflict.statusCode, 409, conflict.body);
      assert.equal(conflict.json().error.code, 'duplicate_conflict');
      assert.equal(ctx.transcriptions(), 1);
      assert.equal(ctx.journal.all().length, count);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const late = await ctx.post(ANSWERS, answer(session.id, 1, 'evt_answer_late'));
        assert.equal(late.statusCode, 409, late.body);
        assert.equal(late.json().error.code, 'stale_revision');
      }
      assert.equal(ctx.transcriptions(), 1);
      assert.equal(ctx.journal.all().length, count);
    } finally {
      await ctx.close();
    }
  });

  it('a reused event id with other audio is a conflict, before transcribing', async () => {
    const ctx = setup();
    try {
      const { session } = await ctx.opened();
      const first = await ctx.post(ANSWERS, answer(session.id, 1));
      assert.equal(first.statusCode, 200, first.body);
      const count = ctx.journal.all().length;
      const other = await ctx.post(ANSWERS, answer(session.id, 1, 'evt_answer_one', OTHER_WAV));
      assert.equal(other.statusCode, 409, other.body);
      assert.equal(other.json().error.code, 'duplicate_conflict');
      assert.equal(ctx.transcriptions(), 1);
      assert.equal(ctx.journal.all().length, count);
    } finally {
      await ctx.close();
    }
  });

  it('an event id that another journal event holds is a conflict, before transcribing', async () => {
    const ctx = setup();
    try {
      const { session, task } = await ctx.opened();
      const taken = boopyEventId(ctx.journal);
      const before = ctx.journal.all().length;
      const answered = await ctx.post(ANSWERS, answer(session.id, 1, taken));
      assert.equal(answered.statusCode, 409, answered.body);
      assert.equal(answered.json().error.code, 'duplicate_conflict');
      const acted = await ctx.post(ACTIONS, {
        eventId: taken,
        sessionId: session.id,
        expectedRevision: 1,
        action: { type: 'retry' },
      });
      assert.equal(acted.statusCode, 409, acted.body);
      assert.equal(acted.json().error.code, 'duplicate_conflict');
      assert.equal(ctx.transcriptions(), 0);
      assert.equal(ctx.journal.all().length, before);
      assert.deepEqual((await ctx.get(`/v1/tasks/${OPEN.taskId}`)).json(), task);
    } finally {
      await ctx.close();
    }
  });

  it('a retry that arrives while the first is transcribing waits for it', {
    timeout: 5000,
  }, async () => {
    const ctx = setup();
    try {
      const { session } = await ctx.opened();
      let release = () => {};
      ctx.hold(
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      );
      const first = ctx.post(ANSWERS, answer(session.id, 1));
      const second = ctx.post(ANSWERS, answer(session.id, 1));
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(ctx.transcriptions(), 1);
      for (const body of [
        answer(session.id, 0),
        answer(session.id, 1, 'evt_answer_one', OTHER_WAV),
      ]) {
        const conflict = await ctx.post(ANSWERS, body);
        assert.equal(conflict.statusCode, 409, conflict.body);
        assert.equal(conflict.json().error.code, 'duplicate_conflict');
      }
      release();
      const [a, b] = await Promise.all([first, second]);
      assert.equal(a.statusCode, 200, a.body);
      assert.deepEqual(b.json(), a.json());
      assert.equal(ctx.transcriptions(), 1);
      assert.equal(a.json().attempts.length, 1);
    } finally {
      await ctx.close();
    }
  });

  it('an action that reuses the event id of an answer still being transcribed is a conflict', {
    timeout: 5000,
  }, async () => {
    const ctx = setup();
    try {
      const { session } = await ctx.opened();
      let release = () => {};
      ctx.hold(
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      );
      const pending = ctx.post(ANSWERS, answer(session.id, 1));
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(ctx.transcriptions(), 1);
      const acted = await ctx.post(ACTIONS, {
        eventId: 'evt_answer_one',
        sessionId: session.id,
        expectedRevision: 1,
        action: { type: 'retry' },
      });
      assert.equal(acted.statusCode, 409, acted.body);
      assert.equal(acted.json().error.code, 'duplicate_conflict');
      release();
      const answered = await pending;
      assert.equal(answered.statusCode, 200, answered.body);
      assert.equal(answered.json().revision, 2);
      assert.equal(answered.json().attempts.length, 1);
    } finally {
      await ctx.close();
    }
  });

  it('refuses an unknown task or another session before transcribing', async () => {
    const ctx = setup();
    try {
      const { session } = await ctx.opened();
      const before = ctx.journal.all().length;
      for (const url of ['/v1/tasks/tsk_missing/answers', '/v1/tasks/tsk%5Fcapture/answers']) {
        const response = await ctx.post(url, answer(session.id, 1));
        assert.equal(response.statusCode, 404, response.body);
        assert.equal(response.json().error.code, 'unknown_task');
      }
      const other = await ctx.post(ANSWERS, answer('ses_other', 1));
      assert.equal(other.statusCode, 409, other.body);
      assert.equal(other.json().error.code, 'session_mismatch');
      assert.equal(ctx.transcriptions(), 0);
      assert.equal(ctx.journal.all().length, before);
    } finally {
      await ctx.close();
    }
  });

  it('a recognizer failure journals nothing', async () => {
    const ctx = setup();
    try {
      const { session, task } = await ctx.opened();
      const before = ctx.journal.all().length;
      ctx.speech.transcribe = async () => {
        throw new Error('Synthetic recognizer failure.');
      };
      const response = await ctx.post(ANSWERS, answer(session.id, 1));
      assert.equal(response.statusCode, 502, response.body);
      assert.equal(response.json().error.code, 'speech_failed');
      assert.equal(response.body.includes('Synthetic'), false);
      assert.equal(ctx.journal.all().length, before);
      assert.deepEqual((await ctx.get(`/v1/tasks/${OPEN.taskId}`)).json(), task);
    } finally {
      await ctx.close();
    }
  });
});

describe('act on a task', () => {
  it('wrong subject clears the parts and keeps the source, and cancel closes the task', async () => {
    const ctx = setup();
    try {
      const { session, task } = await ctx.opened();
      const body = {
        eventId: 'evt_wrong_subject',
        sessionId: session.id,
        expectedRevision: 1,
        action: { type: 'wrong_subject' },
      };
      const response = await ctx.post(ACTIONS, body);
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.headers['cache-control'], 'no-store');
      const view = response.json();
      assert.deepEqual(view.components, [{ type: 'status', code: 'wrong-item' }]);
      assert.equal(view.subjectCorrected, true);
      assert.deepEqual(view.source, task.source);
      assert.equal(view.utterance, task.utterance);
      assert.equal(view.revision, 2);
      assert.equal(view.delivery, 'not-sent');
      const count = ctx.journal.all().length;
      assert.deepEqual((await ctx.post(ACTIONS, body)).json(), view);
      assert.equal(ctx.journal.all().length, count);
      for (const [eventId, type, revision, status] of [
        ['evt_save', 'save_for_later', 2, 'continue-later'],
        ['evt_retry', 'retry', 3, 'try-again'],
        ['evt_cancel', 'cancel', 4, 'continue-later'],
      ] as const) {
        const acted = await ctx.post(ACTIONS, {
          eventId,
          sessionId: session.id,
          expectedRevision: revision,
          action: { type },
        });
        assert.equal(acted.statusCode, 200, acted.body);
        assert.deepEqual(acted.json().components.at(-1), { type: 'status', code: status });
      }
      const closed = (await ctx.get(`/v1/tasks/${OPEN.taskId}`)).json();
      assert.equal(closed.phase, 'cancelled');
      const cancelledAt = ctx.journal.all().length;
      const late = await ctx.post(ANSWERS, answer(session.id, 5));
      assert.equal(late.statusCode, 409, late.body);
      assert.equal(late.json().error.code, 'cancelled');
      assert.equal(ctx.transcriptions(), 0);
      assert.equal(ctx.journal.all().length, cancelledAt);
      assert.deepEqual((await ctx.get(`/v1/tasks/${OPEN.taskId}`)).json(), closed);
      const after = await ctx.post(ACTIONS, {
        eventId: 'evt_after_cancel',
        sessionId: session.id,
        expectedRevision: 5,
        action: { type: 'retry' },
      });
      assert.equal(after.statusCode, 409, after.body);
      assert.equal(after.json().error.code, 'cancelled');
      assert.equal((await ctx.get(`/v1/tasks/${OPEN.taskId}`)).json().revision, 5);
    } finally {
      await ctx.close();
    }
  });

  it('a spoken answer is not an action here, and a stale or unknown action is refused', async () => {
    const ctx = setup();
    try {
      const { session, task } = await ctx.opened();
      const before = ctx.journal.all().length;
      for (const action of [
        { type: 'voice_reply' },
        { type: 'voice_reply', text: ANSWER, recognitionUncertain: false },
      ]) {
        const response = await ctx.post(ACTIONS, {
          eventId: 'evt_spoken_action',
          sessionId: session.id,
          expectedRevision: 1,
          action,
        });
        assert.equal(response.statusCode, 400, response.body);
        assert.equal(response.json().error.code, 'invalid_request');
      }
      assert.equal(ctx.journal.all().length, before);
      const missing = await ctx.post('/v1/tasks/tsk_missing/actions', {
        eventId: 'evt_missing',
        sessionId: session.id,
        expectedRevision: 1,
        action: { type: 'retry' },
      });
      assert.equal(missing.statusCode, 404, missing.body);
      assert.equal(missing.json().error.code, 'unknown_task');
      const stale = await ctx.post(ACTIONS, {
        eventId: 'evt_stale_retry',
        sessionId: session.id,
        expectedRevision: 0,
        action: { type: 'retry' },
      });
      assert.equal(stale.statusCode, 409, stale.body);
      assert.equal(stale.json().error.code, 'stale_revision');
      const now = (await ctx.get(`/v1/tasks/${OPEN.taskId}`)).json();
      assert.equal(now.revision, task.revision);
      assert.deepEqual(now.components, task.components);
      assert.equal(ctx.transcriptions(), 0);
    } finally {
      await ctx.close();
    }
  });
});

/** A recorded interpretation of a device label: the model reads the label in its own case. */
const LABEL_READ: ModelOutput = {
  response: 'The label says PRESS TO RESET. Is the light still blinking?',
  followUps: [],
  scope: 'text',
  referent: { key: 'label', basis: 'pointer', alternatives: [] },
  intent: {
    label: 'Reset the device',
    statement: 'Find out how to reset this device.',
    kind: 'task',
    targetLanguage: null,
    confidence: 0.7,
  },
  items: [
    {
      key: 'label',
      kind: 'text',
      label: 'Press to reset',
      gloss: null,
      statement: 'A printed label beside the button.',
      box: [400, 500, 500, 600],
      point: null,
      scene: false,
      confidence: 0.6,
      why: 'It is under the pointer.',
    },
  ],
  relations: [],
  questions: [],
};

describe('a second kind of task through the same routes', () => {
  it('consults a device label with the same parts, answers and actions, the label as OCR read it', async () => {
    const ctx = setup(() => LABEL_READ);
    try {
      ctx.text.lines = [
        {
          text: 'PRESS TO RESET',
          confidence: 0.9,
          box: { x0: 0.41, y0: 0.53, x1: 0.49, y1: 0.57 },
        },
      ];
      ctx.speech.heard = { text: 'It stopped blinking.', language: 'en' };
      const session = await ctx.start(capture('What does this label say?'));
      const referent = session.items.find((item) => item.id === session.referentId);
      assert.ok(referent && session.dialogue);
      assert.equal(referent.kind, 'text');
      assert.equal(referent.label, 'PRESS TO RESET');
      const before = ctx.journal.all().length;
      const opened = await ctx.post(`/v1/sessions/${session.id}/task`, OPEN);
      assert.equal(opened.statusCode, 200, opened.body);
      const task = opened.json();
      const observed = ctx.journal.all().find((event) => event.type === 'observation.recorded');
      if (observed?.type !== 'observation.recorded') throw new Error('No observation.');
      const source = {
        sourceId: `src_${observed.data.observationId}`,
        sourceRevision: 1,
        sha256: FRAME,
      };
      const parts = [
        { type: 'subject', sourceId: source.sourceId, maskId: null },
        { type: 'annotation', text: 'PRESS TO RESET', evidenceIds: [referent.id] },
        {
          type: 'dialogue',
          text: 'The label says PRESS TO RESET. Is the light still blinking?',
          evidenceIds: [referent.id],
        },
        { type: 'voice_reply', prompt: 'Answer aloud.' },
      ];
      assert.deepEqual(task.source, source);
      assert.equal(task.intent, 'consult_source');
      assert.equal(task.utterance, 'What does this label say?');
      assert.equal(task.revision, 1);
      assert.equal(task.continuity, 'local-only');
      assert.equal(task.delivery, 'not-sent');
      assert.deepEqual(task.components, [...parts, { type: 'status', code: 'not-sent' }]);
      const added = ctx.journal.all().slice(before);
      assert.deepEqual(
        added.map((event) => [event.type, event.actor]),
        [
          ['task.opened', 'system'],
          ['task.provider-accepted', 'system'],
        ],
      );
      const result = added[1];
      if (result?.type !== 'task.provider-accepted') throw new Error('No result.');
      assert.equal(result.data.simulator, true);
      const answered = await ctx.post(ANSWERS, answer(session.id, 1));
      assert.equal(answered.statusCode, 200, answered.body);
      const heard = answered.json();
      assert.equal(heard.revision, 2);
      // A report about the device is still kept as a practice attempt: the one attempt kind.
      assert.deepEqual(heard.attempts, [
        {
          eventId: 'evt_answer_one',
          text: 'It stopped blinking.',
          recognitionUncertain: true,
          kind: 'practice-attempt',
        },
      ]);
      assert.deepEqual(heard.components, task.components);
      assert.equal(heard.delivery, 'not-sent');
      const retried = await ctx.post(ACTIONS, {
        eventId: 'evt_label_retry',
        sessionId: session.id,
        expectedRevision: 2,
        action: { type: 'retry' },
      });
      assert.equal(retried.statusCode, 200, retried.body);
      assert.equal(retried.json().revision, 3);
      assert.deepEqual(retried.json().components, [
        ...parts,
        { type: 'status', code: 'try-again' },
      ]);
      const wrong = await ctx.post(ACTIONS, {
        eventId: 'evt_label_wrong',
        sessionId: session.id,
        expectedRevision: 3,
        action: { type: 'wrong_subject' },
      });
      assert.equal(wrong.statusCode, 200, wrong.body);
      const corrected = wrong.json();
      assert.equal(corrected.revision, 4);
      assert.equal(corrected.subjectCorrected, true);
      assert.deepEqual(corrected.components, [{ type: 'status', code: 'wrong-item' }]);
      assert.deepEqual(corrected.source, source);
      assert.equal(corrected.utterance, 'What does this label say?');
      assert.equal(corrected.continuity, 'local-only');
      assert.equal(corrected.delivery, 'not-sent');
      assert.deepEqual((await ctx.get(`/v1/sessions/${session.id}`)).json(), session);
      assert.equal(ctx.modelCalls(), 1);
      assert.equal(ctx.transcriptions(), 1);
      assert.equal(ctx.requests(), 0);
    } finally {
      await ctx.close();
    }
  });

  it('a label outside the display rules gets no annotation and keeps the line and Answer aloud', async () => {
    const reply = 'The label names a reset setting. Is the light still blinking?';
    const ctx = setup(() => ({
      ...LABEL_READ,
      response: reply,
      items: LABEL_READ.items.map((item) => ({ ...item, label: 'RESET 10 kΩ' })),
    }));
    try {
      ctx.text.lines = [
        {
          text: 'RESET 10 kΩ',
          confidence: 0.9,
          box: { x0: 0.41, y0: 0.53, x1: 0.49, y1: 0.57 },
        },
      ];
      const session = await ctx.start(capture('What does this label say?'));
      const referent = session.items.find((item) => item.id === session.referentId);
      assert.ok(referent);
      assert.equal(referent.label, 'RESET 10 kΩ');
      const opened = await ctx.post(`/v1/sessions/${session.id}/task`, OPEN);
      assert.equal(opened.statusCode, 200, opened.body);
      const task = opened.json();
      assert.deepEqual(task.components, [
        { type: 'subject', sourceId: task.source.sourceId, maskId: null },
        { type: 'dialogue', text: reply, evidenceIds: [referent.id] },
        { type: 'voice_reply', prompt: 'Answer aloud.' },
        { type: 'status', code: 'not-sent' },
      ]);
      assert.equal(task.delivery, 'not-sent');
      assert.deepEqual((await ctx.get(`/v1/sessions/${session.id}`)).json(), session);
    } finally {
      await ctx.close();
    }
  });
});

describe('task routes on the headset boundary', () => {
  it('refuses a non-loopback Host or a browser Origin on every task route', async () => {
    const ctx = setup();
    try {
      const { session, task } = await ctx.opened();
      const before = ctx.journal.all().length;
      const calls: [string, object][] = [
        [`/v1/sessions/${session.id}/task`, OPEN],
        [ANSWERS, answer(session.id, 1)],
        [
          ACTIONS,
          {
            eventId: 'evt_wrong_subject',
            sessionId: session.id,
            expectedRevision: 1,
            action: { type: 'wrong_subject' },
          },
        ],
      ];
      for (const [url, body] of calls) {
        const foreign = await ctx.post(url, body, { host: 'evil.example' });
        assert.equal(foreign.statusCode, 403, `${url} ${foreign.body}`);
        assert.equal(foreign.json().error.code, 'forbidden_host');
        const browser = await ctx.post(url, body, { origin: 'https://evil.example' });
        assert.equal(browser.statusCode, 403, `${url} ${browser.body}`);
        assert.equal(browser.json().error.code, 'browser_not_allowed');
      }
      const read = await ctx.get(`/v1/tasks/${OPEN.taskId}`, { origin: 'https://evil.example' });
      assert.equal(read.statusCode, 403, read.body);
      assert.equal(read.json().error.code, 'browser_not_allowed');
      assert.equal(read.body.includes(SAID), false);
      assert.equal(ctx.journal.all().length, before);
      assert.equal(ctx.transcriptions(), 0);
      assert.deepEqual((await ctx.get(`/v1/tasks/${OPEN.taskId}`)).json(), task);
    } finally {
      await ctx.close();
    }
  });

  it('the open and action routes take at most 16 KiB, and answers keep the headset limit', async () => {
    const ctx = setup();
    try {
      const session = await ctx.start();
      const before = ctx.journal.all().length;
      const padding = 'x'.repeat(17 * 1024);
      const open = await ctx.post(`/v1/sessions/${session.id}/task`, { ...OPEN, padding });
      assert.equal(open.statusCode, 413, open.body);
      const acted = await ctx.post(ACTIONS, {
        eventId: 'evt_large',
        sessionId: session.id,
        expectedRevision: 0,
        action: { type: 'retry' },
        padding,
      });
      assert.equal(acted.statusCode, 413, acted.body);
      assert.equal(ctx.journal.all().length, before);
      const opened = await ctx.post(`/v1/sessions/${session.id}/task`, OPEN);
      assert.equal(opened.statusCode, 200, opened.body);
      const spoken = await ctx.post(
        ANSWERS,
        answer(session.id, 1, 'evt_answer_large', Buffer.alloc(64 * 1024, 1).toString('base64')),
      );
      assert.equal(spoken.statusCode, 200, spoken.body);
    } finally {
      await ctx.close();
    }
  });

  it('no field accepts a claim of delivery or continuity', async () => {
    const ctx = setup();
    try {
      const fresh = await ctx.start();
      const claims = [{ delivery: 'sent' }, { continuity: 'grok-bot' }];
      for (const claim of claims) {
        const response = await ctx.post(`/v1/sessions/${fresh.id}/task`, { ...OPEN, ...claim });
        assert.equal(response.statusCode, 400, response.body);
        assert.equal(response.json().error.code, 'invalid_request');
      }
      assert.equal(ctx.tasks.forSession(fresh.id), undefined);
      const opened = await ctx.post(`/v1/sessions/${fresh.id}/task`, OPEN);
      const task = opened.json();
      const before = ctx.journal.all().length;
      const bodies = claims.flatMap((claim) => [
        [ANSWERS, { ...answer(fresh.id, 1), ...claim }],
        [ANSWERS, { ...answer(fresh.id, 1), speech: { wav: WAV, ...claim } }],
        [
          ACTIONS,
          {
            eventId: 'evt_claim',
            sessionId: fresh.id,
            expectedRevision: 1,
            action: { type: 'retry' },
            ...claim,
          },
        ],
        [
          ACTIONS,
          {
            eventId: 'evt_claim',
            sessionId: fresh.id,
            expectedRevision: 1,
            action: { type: 'retry', ...claim },
          },
        ],
      ]) as [string, object][];
      for (const [url, body] of bodies) {
        const response = await ctx.post(url, body);
        assert.equal(response.statusCode, 400, `${url} ${response.body}`);
        assert.equal(response.json().error.code, 'invalid_request');
        assert.equal(response.body.includes('grok-bot'), false);
      }
      assert.equal(ctx.journal.all().length, before);
      assert.equal(ctx.transcriptions(), 0);
      const now = (await ctx.get(`/v1/tasks/${OPEN.taskId}`)).json();
      assert.deepEqual(now, task);
      assert.equal(now.delivery, 'not-sent');
      assert.equal(now.continuity, 'local-only');
    } finally {
      await ctx.close();
    }
  });

  it('an answer over the headset body limit is refused unread', async () => {
    const ctx = setup();
    try {
      const { session } = await ctx.opened();
      const before = ctx.journal.all().length;
      const response = await ctx.post(ANSWERS, {
        ...answer(session.id, 1),
        speech: { wav: 'A'.repeat(9 * 1024 * 1024) },
      });
      assert.equal(response.statusCode, 413, response.body);
      assert.equal(ctx.transcriptions(), 0);
      assert.equal(ctx.journal.all().length, before);
    } finally {
      await ctx.close();
    }
  });
});
