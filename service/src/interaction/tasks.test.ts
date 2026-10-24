import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { Journal } from '../journal.ts';
import { Projection } from '../session.ts';
import { ProviderResult, type TaskOutcome } from './contract.ts';
import { TaskStore } from './tasks.ts';

const AT = '1970-01-01T00:00:00.000Z';
const SHA = 'a'.repeat(64);
const SOURCE = { sourceId: 'src_sahara_still', sourceRevision: 1, sha256: SHA };
const SESSION = 'sess_owner';

function store() {
  return new TaskStore(Journal.open(':memory:'));
}

function open(
  tasks: TaskStore,
  intent: 'continue_saved_task' | 'consult_source' = 'continue_saved_task',
) {
  return tasks.open(
    {
      eventId: 'evt_open_sahara',
      sessionId: SESSION,
      taskId: 'tsk_sahara_later',
      source: SOURCE,
      intent,
      utterance: 'Sahara. Save it. Korean later.',
    },
    AT,
  );
}

const lesson = {
  resultId: 'res_korean_prompt',
  sessionId: SESSION,
  taskId: 'tsk_sahara_later',
  baseRevision: 0,
  source: SOURCE,
  evidenceIds: ['ev_camel'],
  components: [
    { type: 'subject', sourceId: 'src_sahara_still', maskId: 'msk_camel' },
    { type: 'annotation', text: 'Camel', evidenceIds: ['ev_camel'] },
    { type: 'dialogue', text: '이 사진에 뭐가 있어요?', evidenceIds: ['ev_camel'] },
    { type: 'voice_reply', prompt: 'Answer aloud about this picture.' },
    { type: 'agent_presence', mode: 'engaged' },
  ],
};

describe('local interaction tasks', () => {
  it('saves a pending task without inventing a lesson or a Bot delivery', () => {
    const tasks = store();
    const opened = open(tasks);
    assert.equal(opened.status, 'accepted');
    if (opened.status !== 'accepted') return;
    assert.equal(opened.task.continuity, 'local-only');
    assert.equal(opened.task.delivery, 'not-sent');
    assert.equal(opened.task.revision, 0);
    assert.deepEqual(opened.task.components, [{ type: 'status', code: 'not-sent' }]);
    assert.equal(opened.task.utterance, 'Sahara. Save it. Korean later.');
    assert.equal(opened.task.attempts.length, 0);
    assert.deepEqual(open(tasks), opened);
  });

  it('accepts one lesson, records an uncertain attempt, and rejects stale or conflicting returns', () => {
    const tasks = store();
    assert.equal(open(tasks).status, 'accepted');
    const received = tasks.receive(lesson, AT);
    assert.equal(received.status, 'accepted');
    if (received.status !== 'accepted') return;
    assert.equal(received.task.revision, 1);
    assert.equal(received.task.continuity, 'local-only');
    assert.equal(received.task.delivery, 'not-sent');
    const status = received.task.components.at(-1);
    assert.equal(status?.type, 'status');
    if (status?.type === 'status') assert.equal(status.code, 'not-sent');
    const answer = tasks.act(
      {
        eventId: 'evt_answer',
        sessionId: SESSION,
        taskId: 'tsk_sahara_later',
        expectedRevision: 1,
        action: { type: 'voice_reply', text: '낙타가 있어요', recognitionUncertain: true },
      },
      AT,
    );
    assert.equal(answer.status, 'accepted');
    if (answer.status !== 'accepted') return;
    assert.equal(answer.task.revision, 2);
    assert.deepEqual(answer.task.attempts, [
      {
        eventId: 'evt_answer',
        text: '낙타가 있어요',
        recognitionUncertain: true,
        kind: 'practice-attempt',
      },
    ]);
    assert.equal(answer.task.source.sha256, SHA);
    assert.deepEqual(
      tasks.act(
        {
          eventId: 'evt_answer',
          sessionId: SESSION,
          taskId: 'tsk_sahara_later',
          expectedRevision: 1,
          action: { type: 'voice_reply', text: '낙타가 있어요', recognitionUncertain: true },
        },
        AT,
      ),
      answer,
    );
    const conflict = tasks.act(
      {
        eventId: 'evt_answer',
        sessionId: SESSION,
        taskId: 'tsk_sahara_later',
        expectedRevision: 2,
        action: { type: 'voice_reply', text: '다른 대답', recognitionUncertain: false },
      },
      AT,
    );
    assert.equal(conflict.status, 'rejected');
    if (conflict.status !== 'rejected') return;
    assert.equal(conflict.code, 'duplicate_conflict');
    const stale = tasks.act(
      {
        eventId: 'evt_stale_answer',
        sessionId: SESSION,
        taskId: 'tsk_sahara_later',
        expectedRevision: 1,
        action: { type: 'retry' },
      },
      AT,
    );
    assert.equal(stale.status, 'rejected');
    if (stale.status !== 'rejected') return;
    assert.equal(stale.code, 'stale_revision');
    assert.equal(stale.task?.revision, 2);
    const staleLesson = tasks.receive({ ...lesson, resultId: 'res_stale', baseRevision: 0 }, AT);
    assert.equal(staleLesson.status, 'rejected');
    if (staleLesson.status !== 'rejected') return;
    assert.equal(staleLesson.code, 'stale_revision');
    assert.equal(staleLesson.task?.revision, 2);
    assert.equal(
      staleLesson.task?.components.some((component) => component.type === 'dialogue'),
      true,
    );
  });

  it('a wrong subject drops dependent content and does not rewrite the source', () => {
    const tasks = store();
    open(tasks);
    tasks.receive(lesson, AT);
    const corrected = tasks.act(
      {
        eventId: 'evt_wrong',
        sessionId: SESSION,
        taskId: 'tsk_sahara_later',
        expectedRevision: 1,
        action: { type: 'wrong_subject' },
      },
      AT,
    );
    assert.equal(corrected.status, 'accepted');
    if (corrected.status !== 'accepted') return;
    assert.equal(corrected.task.subjectCorrected, true);
    assert.deepEqual(corrected.task.components, [{ type: 'status', code: 'wrong-item' }]);
    assert.equal(corrected.task.source.sha256, SHA);
    assert.equal(corrected.task.source.sourceRevision, 1);
  });

  it('cancellation blocks a later mutation and a second task reuses the same components', () => {
    const tasks = store();
    open(tasks);
    const cancelled = tasks.act(
      {
        eventId: 'evt_cancel',
        sessionId: SESSION,
        taskId: 'tsk_sahara_later',
        expectedRevision: 0,
        action: { type: 'cancel' },
      },
      AT,
    );
    assert.equal(cancelled.status, 'accepted');
    if (cancelled.status !== 'accepted') return;
    assert.equal(cancelled.task.phase, 'cancelled');
    const blocked = tasks.receive(lesson, AT);
    assert.equal(blocked.status, 'rejected');
    if (blocked.status !== 'rejected') return;
    assert.equal(blocked.code, 'cancelled');
    assert.equal(blocked.task?.revision, 1);
    const manual = tasks.open(
      {
        eventId: 'evt_open_manual',
        sessionId: SESSION,
        taskId: 'tsk_manual',
        source: { ...SOURCE, sourceId: 'src_device_label' },
        intent: 'consult_source',
        utterance: 'What does this label say?',
      },
      AT,
    );
    assert.equal(manual.status, 'accepted');
    const guide = tasks.receive(
      {
        resultId: 'res_manual',
        sessionId: SESSION,
        taskId: 'tsk_manual',
        baseRevision: 0,
        source: { ...SOURCE, sourceId: 'src_device_label' },
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
    assert.equal(guide.status, 'accepted');
    if (guide.status !== 'accepted') return;
    assert.equal(guide.task.intent, 'consult_source');
    assert.equal(guide.task.continuity, 'local-only');
    assert.equal(
      guide.task.components.some((component) => component.type === 'choice'),
      true,
    );
    assert.equal(
      guide.task.components.some((component) => component.type === 'voice_reply'),
      false,
    );
  });

  it('refuses a provider payload that claims Bot continuity', () => {
    assert.throws(() => ProviderResult.parse({ ...lesson, continuity: 'grok-bot' }));
  });

  it('does not create conversation facts from task events', () => {
    const journal = Journal.open(':memory:');
    journal.append(
      {
        type: 'session.started',
        session: SESSION,
        actor: 'person',
        data: { device: null },
      },
      'evt_session',
      AT,
    );
    const tasks = new TaskStore(journal);
    open(tasks);
    const projection = Projection.from(journal.all());
    const session = projection.session(SESSION);
    assert.ok(session);
    assert.equal(session?.dialogue, null);
    assert.equal(session?.corrections, 0);
    assert.equal(session?.items.length, 0);
    const alone = Journal.open(':memory:');
    new TaskStore(alone).open(
      {
        eventId: 'evt_open_sahara',
        sessionId: SESSION,
        taskId: 'tsk_sahara_later',
        source: SOURCE,
        intent: 'save_for_later',
        utterance: 'Sahara. Save it. Korean later.',
      },
      AT,
    );
    assert.equal(Projection.from(alone.all()).session(SESSION), undefined);
    assert.equal(new TaskStore(alone).get('tsk_sahara_later')?.intent, 'save_for_later');
  });

  it('a mismatched source changes nothing and a valid result restores one dialogue line', () => {
    const journal = Journal.open(':memory:');
    const tasks = new TaskStore(journal);
    assert.equal(open(tasks).status, 'accepted');
    const received = tasks.receive(lesson, AT);
    assert.equal(received.status, 'accepted');
    if (received.status !== 'accepted') return;
    const before = tasks.get('tsk_sahara_later');
    assert.ok(before);
    if (!before) return;
    const otherSha = 'b'.repeat(64);
    const mismatched = {
      resultId: 'res_wrong_digest',
      sessionId: SESSION,
      taskId: 'tsk_sahara_later',
      baseRevision: before.revision,
      source: { sourceId: 'src_sahara_still', sourceRevision: 2, sha256: otherSha },
      evidenceIds: ['ev_camel'],
      components: [
        { type: 'dialogue', text: 'This line does not land.', evidenceIds: ['ev_camel'] },
      ],
    };
    const mismatch = tasks.receive(mismatched, AT);
    assert.equal(mismatch.status, 'rejected');
    if (mismatch.status !== 'rejected') return;
    assert.equal(mismatch.code, 'source_mismatch');
    assert.equal(mismatch.task?.revision, before.revision);
    assert.equal(mismatch.task?.source.sha256, SHA);
    assert.equal(mismatch.task?.source.sourceRevision, 1);
    assert.equal(mismatch.task?.source.sourceId, 'src_sahara_still');
    assert.equal(mismatch.task?.delivery, 'not-sent');
    assert.equal(mismatch.task?.continuity, 'local-only');
    assert.equal(mismatch.task?.subjectCorrected, false);
    assert.deepEqual(mismatch.task?.components, before.components);
    assert.deepEqual(tasks.receive(mismatched, AT), mismatch);
    const refused = journal.all().find((event) => event.id === 'res_wrong_digest');
    assert.equal(refused?.type, 'task.provider-rejected');
    if (refused?.type !== 'task.provider-rejected') return;
    assert.equal(refused.data.code, 'source_mismatch');
    assert.equal(refused.data.revision, before.revision);
    assert.equal(refused.data.simulator, true);
    assert.equal(refused.data.source.sha256, otherSha);
    const claimed = journal.all().find((event) => event.id === 'res_korean_prompt');
    assert.equal(claimed?.type, 'task.provider-accepted');
    if (claimed?.type !== 'task.provider-accepted') return;
    assert.equal(claimed.data.simulator, true);
    assert.equal(claimed.data.source.sha256, SHA);
    assert.equal(tasks.get('tsk_sahara_later')?.source.sha256, SHA);
    const restored = tasks.receive(
      {
        resultId: 'res_korean_restored',
        sessionId: SESSION,
        taskId: 'tsk_sahara_later',
        baseRevision: before.revision,
        source: SOURCE,
        evidenceIds: ['ev_camel'],
        components: [
          { type: 'dialogue', text: '이 사진에 뭐가 있어요?', evidenceIds: ['ev_camel'] },
        ],
      },
      AT,
    );
    assert.equal(restored.status, 'accepted');
    if (restored.status !== 'accepted') return;
    assert.equal(restored.task.revision, before.revision + 1);
    assert.equal(restored.task.source.sha256, SHA);
    assert.equal(restored.task.source.sourceRevision, 1);
    assert.equal(restored.task.source.sourceId, 'src_sahara_still');
    assert.equal(restored.task.delivery, 'not-sent');
    assert.equal(restored.task.continuity, 'local-only');
    assert.equal(restored.task.subjectCorrected, false);
    assert.deepEqual(restored.task.components, [
      { type: 'dialogue', text: '이 사진에 뭐가 있어요?', evidenceIds: ['ev_camel'] },
      { type: 'status', code: 'not-sent' },
    ]);
    const accepted = journal.all().find((event) => event.id === 'res_korean_restored');
    assert.equal(accepted?.type, 'task.provider-accepted');
    if (accepted?.type !== 'task.provider-accepted') return;
    assert.equal(accepted.actor, 'system');
    assert.equal(accepted.data.simulator, true);
    assert.equal(accepted.data.outcome, 'accepted');
    assert.equal(accepted.data.source.sha256, SHA);
    assert.equal(accepted.data.revision, before.revision + 1);
  });

  it('a retry sets try again and leaves the provider components in place', () => {
    const tasks = store();
    assert.equal(open(tasks).status, 'accepted');
    const received = tasks.receive(lesson, AT);
    assert.equal(received.status, 'accepted');
    if (received.status !== 'accepted') return;
    const retry = tasks.act(
      {
        eventId: 'evt_retry_lesson',
        sessionId: SESSION,
        taskId: 'tsk_sahara_later',
        expectedRevision: 1,
        action: { type: 'retry' },
      },
      AT,
    );
    assert.equal(retry.status, 'accepted');
    if (retry.status !== 'accepted') return;
    assert.equal(retry.task.revision, 2);
    assert.equal(retry.task.source.sourceRevision, 1);
    assert.equal(retry.task.source.sha256, SHA);
    assert.equal(retry.task.subjectCorrected, false);
    assert.equal(retry.task.delivery, 'not-sent');
    assert.equal(retry.task.continuity, 'local-only');
    assert.equal(retry.task.phase, 'open');
    assert.deepEqual(retry.task.attempts, []);
    assert.deepEqual(retry.task.components.slice(0, -1), lesson.components);
    assert.equal(retry.task.components.length, lesson.components.length + 1);
    const status = retry.task.components.at(-1);
    assert.equal(status?.type, 'status');
    if (status?.type === 'status') assert.equal(status.code, 'try-again');
  });

  it('consulting a device label uses the same actions and components', () => {
    const journal = Journal.open(':memory:');
    const tasks = new TaskStore(journal);
    const labelSource = { ...SOURCE, sourceId: 'src_device_label' };
    const labelParts = [
      { type: 'subject', sourceId: 'src_device_label', maskId: null },
      { type: 'annotation', text: 'Label', evidenceIds: ['ev_label'] },
      { type: 'dialogue', text: 'The label is unread.', evidenceIds: ['ev_label'] },
      {
        type: 'choice',
        prompt: 'Read it again?',
        options: [{ id: 'opt_retry', label: 'Try again' }],
      },
    ];
    const manual = tasks.open(
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
    assert.equal(manual.status, 'accepted');
    if (manual.status !== 'accepted') return;
    assert.equal(manual.task.intent, 'consult_source');
    assert.equal(manual.task.revision, 0);
    assert.equal(manual.task.source.sourceRevision, 1);
    assert.equal(manual.task.delivery, 'not-sent');
    assert.equal(manual.task.continuity, 'local-only');
    assert.equal(manual.task.subjectCorrected, false);
    assert.deepEqual(manual.task.components, [{ type: 'status', code: 'not-sent' }]);
    const guide = tasks.receive(
      {
        resultId: 'res_manual',
        sessionId: SESSION,
        taskId: 'tsk_manual',
        baseRevision: 0,
        source: labelSource,
        evidenceIds: ['ev_label'],
        components: labelParts,
      },
      AT,
    );
    assert.equal(guide.status, 'accepted');
    if (guide.status !== 'accepted') return;
    assert.equal(guide.task.revision, 1);
    assert.equal(guide.task.source.sha256, SHA);
    assert.equal(guide.task.subjectCorrected, false);
    assert.equal(guide.task.delivery, 'not-sent');
    assert.equal(guide.task.continuity, 'local-only');
    assert.deepEqual(guide.task.components.slice(0, -1), labelParts);
    const claimed = journal.all().find((event) => event.id === 'res_manual');
    assert.equal(claimed?.type, 'task.provider-accepted');
    if (claimed?.type !== 'task.provider-accepted') return;
    assert.equal(claimed.actor, 'system');
    assert.equal(claimed.data.simulator, true);
    assert.equal(claimed.data.revision, 1);
    assert.deepEqual(claimed.data.source, labelSource);
    const claimSource = claimed.data.source;
    const claimComponents = claimed.data.components;
    const retry = tasks.act(
      {
        eventId: 'evt_label_retry',
        sessionId: SESSION,
        taskId: 'tsk_manual',
        expectedRevision: 1,
        action: { type: 'retry' },
      },
      AT,
    );
    assert.equal(retry.status, 'accepted');
    if (retry.status !== 'accepted') return;
    assert.equal(retry.task.revision, 2);
    assert.equal(retry.task.source.sourceRevision, 1);
    assert.equal(retry.task.source.sha256, SHA);
    assert.equal(retry.task.source.sourceId, 'src_device_label');
    assert.equal(retry.task.subjectCorrected, false);
    assert.equal(retry.task.delivery, 'not-sent');
    assert.equal(retry.task.continuity, 'local-only');
    assert.deepEqual(retry.task.components.slice(0, -1), labelParts);
    const status = retry.task.components.at(-1);
    assert.equal(status?.type, 'status');
    if (status?.type === 'status') assert.equal(status.code, 'try-again');
    const corrected = tasks.act(
      {
        eventId: 'evt_label_wrong',
        sessionId: SESSION,
        taskId: 'tsk_manual',
        expectedRevision: 2,
        action: { type: 'wrong_subject' },
      },
      AT,
    );
    assert.equal(corrected.status, 'accepted');
    if (corrected.status !== 'accepted') return;
    assert.equal(corrected.task.subjectCorrected, true);
    assert.equal(corrected.task.revision, 3);
    assert.equal(corrected.task.source.sourceRevision, 1);
    assert.equal(corrected.task.source.sha256, SHA);
    assert.equal(corrected.task.source.sourceId, 'src_device_label');
    assert.equal(corrected.task.utterance, 'What does this label say?');
    assert.equal(corrected.task.delivery, 'not-sent');
    assert.equal(corrected.task.continuity, 'local-only');
    assert.deepEqual(corrected.task.components, [{ type: 'status', code: 'wrong-item' }]);
    const still = journal.all().find((event) => event.id === 'res_manual');
    assert.equal(still?.type, 'task.provider-accepted');
    if (still?.type !== 'task.provider-accepted') return;
    assert.equal(still.data.revision, 1);
    assert.deepEqual(still.data.source, claimSource);
    assert.deepEqual(still.data.components, claimComponents);
    assert.equal(still.data.simulator, true);
    const retried = journal.all().find((event) => event.id === 'evt_label_retry');
    assert.equal(retried?.type, 'task.action-accepted');
    if (retried?.type !== 'task.action-accepted') return;
    assert.equal(retried.actor, 'person');
    assert.deepEqual(retried.data.action, { type: 'retry' });
    assert.equal(retried.data.revision, 2);
    assert.equal(Object.hasOwn(retried.data, 'source'), false);
    const correction = journal.all().find((event) => event.id === 'evt_label_wrong');
    assert.equal(correction?.type, 'task.action-accepted');
    if (correction?.type !== 'task.action-accepted') return;
    assert.equal(correction.actor, 'person');
    assert.deepEqual(correction.data.action, { type: 'wrong_subject' });
    assert.equal(correction.data.revision, 3);
    assert.equal(Object.hasOwn(correction.data, 'source'), false);
    const opened = journal.all().find((event) => event.id === 'evt_open_manual');
    assert.equal(opened?.type, 'task.opened');
    if (opened?.type !== 'task.opened') return;
    assert.equal(opened.data.revision, 0);
    assert.deepEqual(opened.data.source, corrected.task.source);
    assert.equal(opened.data.utterance, corrected.task.utterance);
  });
});

describe('a task opened together with its first result', () => {
  const opening = {
    eventId: 'evt_open_capture',
    sessionId: SESSION,
    taskId: 'tsk_capture',
    source: SOURCE,
    intent: 'consult_source',
    utterance: 'What is this?',
  } as const;
  const first = {
    resultId: 'res_capture',
    sessionId: SESSION,
    taskId: 'tsk_capture',
    baseRevision: 0,
    source: SOURCE,
    evidenceIds: ['ev_photo'],
    components: [
      { type: 'subject', sourceId: 'src_sahara_still', maskId: null },
      { type: 'voice_reply', prompt: 'Answer aloud.' },
    ],
  };

  /** An outcome's status when accepted, or its refusal code. */
  const kind = (outcome: TaskOutcome | undefined) =>
    outcome === undefined ? undefined : outcome.status === 'accepted' ? 'accepted' : outcome.code;

  it('appends the opening and the result as one step, the system opening it', () => {
    const journal = Journal.open(':memory:');
    const tasks = new TaskStore(journal);
    assert.equal(tasks.forSession(SESSION), undefined);
    const outcome = tasks.openWithResult(opening, first, AT);
    assert.equal(outcome.status, 'accepted');
    if (outcome.status !== 'accepted') return;
    assert.equal(outcome.task.revision, 1);
    assert.equal(outcome.task.intent, 'consult_source');
    assert.equal(outcome.task.utterance, 'What is this?');
    assert.equal(outcome.task.continuity, 'local-only');
    assert.equal(outcome.task.delivery, 'not-sent');
    assert.deepEqual(outcome.task.components, [
      ...first.components,
      { type: 'status', code: 'not-sent' },
    ]);
    assert.deepEqual(
      journal.all().map((event) => [event.type, event.actor, event.id]),
      [
        ['task.opened', 'system', 'evt_open_capture'],
        ['task.provider-accepted', 'system', 'res_capture'],
      ],
    );
    assert.deepEqual(tasks.forSession(SESSION), outcome.task);
    assert.deepEqual(new TaskStore(journal).get('tsk_capture'), outcome.task);
    assert.equal(tasks.forSession('sess_other'), undefined);
    assert.deepEqual(tasks.openWithResult(opening, first, AT), outcome);
    assert.equal(journal.all().length, 2);
  });

  it('a failure on the second append leaves no opening behind', () => {
    const journal = Journal.open(':memory:');
    const tasks = new TaskStore(journal);
    const append = journal.append.bind(journal);
    journal.append = (event, id, at) => {
      if (event.type === 'task.provider-accepted') throw new Error('Synthetic disk failure.');
      return append(event, id, at);
    };
    assert.throws(() => tasks.openWithResult(opening, first, AT), /Synthetic disk failure/);
    assert.deepEqual(journal.all(), []);
    assert.equal(tasks.forSession(SESSION), undefined);
    journal.append = append;
    assert.equal(kind(tasks.openWithResult(opening, first, AT)), 'accepted');
    assert.equal(journal.all().length, 2);
  });

  it('finds the earliest task a session has', () => {
    const tasks = store();
    tasks.open({ ...opening, eventId: 'evt_first', taskId: 'tsk_first' }, AT);
    tasks.open(
      { ...opening, eventId: 'evt_elsewhere', taskId: 'tsk_elsewhere', sessionId: 'sess_other' },
      AT,
    );
    tasks.open({ ...opening, eventId: 'evt_second', taskId: 'tsk_second' }, AT);
    assert.equal(tasks.forSession(SESSION)?.taskId, 'tsk_first');
    assert.equal(tasks.forSession('sess_other')?.taskId, 'tsk_elsewhere');
  });

  it('refuses an id that another journal event already holds, appending nothing', () => {
    const journal = Journal.open(':memory:');
    for (const id of ['evt_taken', 'res_taken'])
      journal.append(
        { type: 'session.started', session: 'ses_boopy', actor: 'person', data: { device: null } },
        id,
        AT,
      );
    const tasks = new TaskStore(journal);
    assert.equal(kind(tasks.open({ ...opening, eventId: 'evt_taken' }, AT)), 'duplicate_conflict');
    assert.equal(
      kind(tasks.openWithResult({ ...opening, eventId: 'evt_taken' }, first, AT)),
      'duplicate_conflict',
    );
    assert.equal(
      kind(tasks.openWithResult(opening, { ...first, resultId: 'res_taken' }, AT)),
      'duplicate_conflict',
    );
    assert.equal(journal.all().length, 2);
    assert.equal(kind(tasks.openWithResult(opening, first, AT)), 'accepted');
    const retry = {
      eventId: 'evt_taken',
      sessionId: SESSION,
      taskId: 'tsk_capture',
      expectedRevision: 1,
      action: { type: 'retry' },
    };
    assert.equal(kind(tasks.act(retry, AT)), 'duplicate_conflict');
    assert.equal(
      kind(tasks.receive({ ...first, resultId: 'res_taken', baseRevision: 1 }, AT)),
      'duplicate_conflict',
    );
    assert.equal(journal.all().length, 4);
    assert.equal(tasks.get('tsk_capture')?.revision, 1);
  });

  it('appends nothing when either half would be refused', () => {
    const journal = Journal.open(':memory:');
    const tasks = new TaskStore(journal);
    assert.equal(open(tasks).status, 'accepted');
    assert.equal(tasks.receive(lesson, AT).status, 'accepted');
    const before = journal.all().length;
    const reusedResult = tasks.openWithResult(
      opening,
      { ...first, resultId: 'res_korean_prompt' },
      AT,
    );
    assert.equal(reusedResult.status, 'rejected');
    if (reusedResult.status !== 'rejected') return;
    assert.equal(reusedResult.code, 'duplicate_conflict');
    const reusedEvent = tasks.openWithResult({ ...opening, eventId: 'evt_open_sahara' }, first, AT);
    assert.equal(reusedEvent.status, 'rejected');
    if (reusedEvent.status !== 'rejected') return;
    assert.equal(reusedEvent.code, 'duplicate_conflict');
    const otherSession = tasks.openWithResult(
      { ...opening, sessionId: 'sess_other', taskId: 'tsk_sahara_later' },
      { ...first, sessionId: 'sess_other', taskId: 'tsk_sahara_later' },
      AT,
    );
    assert.equal(otherSession.status, 'rejected');
    if (otherSession.status !== 'rejected') return;
    assert.equal(otherSession.code, 'task_exists');
    assert.equal(otherSession.task, null);
    assert.equal(journal.all().length, before);
    assert.equal(tasks.get('tsk_capture'), undefined);
    assert.throws(() => tasks.openWithResult(opening, { ...first, baseRevision: 1 }, AT));
    assert.throws(() => tasks.openWithResult(opening, { ...first, taskId: 'tsk_elsewhere' }, AT));
    assert.equal(journal.all().length, before);
  });

  it('finishes a task opened without its first result, with the same opening only', () => {
    const journal = Journal.open(':memory:');
    const tasks = new TaskStore(journal);
    assert.equal(tasks.open(opening, AT).status, 'accepted');
    assert.equal(journal.all()[0]?.actor, 'person');
    const otherTurn = tasks.openWithResult({ ...opening, utterance: 'Another turn.' }, first, AT);
    assert.equal(otherTurn.status, 'rejected');
    if (otherTurn.status !== 'rejected') return;
    assert.equal(otherTurn.code, 'task_exists');
    assert.equal(otherTurn.task?.revision, 0);
    assert.equal(journal.all().length, 1);
    const finished = tasks.openWithResult({ ...opening, eventId: 'evt_open_retry' }, first, AT);
    assert.equal(finished.status, 'accepted');
    if (finished.status !== 'accepted') return;
    assert.equal(finished.task.revision, 1);
    assert.deepEqual(
      journal.all().map((event) => event.type),
      ['task.opened', 'task.provider-accepted'],
    );
    assert.deepEqual(tasks.openWithResult(opening, first, AT), finished);
    assert.equal(journal.all().length, 2);
  });

  it('keeps an answer audio digest and recognizer in the journal, never in the attempt', () => {
    const journal = Journal.open(':memory:');
    const tasks = new TaskStore(journal);
    assert.equal(kind(tasks.openWithResult(opening, first, AT)), 'accepted');
    const audio = 'd'.repeat(64);
    const action = {
      type: 'voice_reply',
      text: 'Two camels.',
      recognitionUncertain: true,
      audioSha256: audio,
      recognizer: 'fake speech',
    };
    const answered = tasks.act(
      {
        eventId: 'evt_spoken',
        sessionId: SESSION,
        taskId: 'tsk_capture',
        expectedRevision: 1,
        action,
      },
      AT,
    );
    assert.equal(answered.status, 'accepted');
    if (answered.status !== 'accepted') return;
    assert.deepEqual(answered.task.attempts, [
      {
        eventId: 'evt_spoken',
        text: 'Two camels.',
        recognitionUncertain: true,
        kind: 'practice-attempt',
      },
    ]);
    const recorded = journal.all().at(-1);
    assert.equal(recorded?.type, 'task.action-accepted');
    if (recorded?.type !== 'task.action-accepted') return;
    assert.deepEqual(recorded.data.action, action);
    const unset = tasks.act(
      {
        eventId: 'evt_unset',
        sessionId: SESSION,
        taskId: 'tsk_capture',
        expectedRevision: 2,
        action: { ...action, text: 'No digest.', audioSha256: undefined, recognizer: undefined },
      },
      AT,
    );
    assert.equal(kind(unset), 'accepted');
    assert.equal(new TaskStore(journal).get('tsk_capture')?.revision, 3);
    for (const wrong of [
      { audioSha256: 'not-a-digest' },
      { recognizer: '' },
      { recognizer: 'a\nb' },
    ])
      assert.throws(() =>
        tasks.act(
          {
            eventId: 'evt_wrong',
            sessionId: SESSION,
            taskId: 'tsk_capture',
            expectedRevision: 3,
            action: { ...action, ...wrong },
          },
          AT,
        ),
      );
    assert.equal(journal.all().length, 4);
  });

  it('checks a spoken answer before any transcription, appending nothing', () => {
    const journal = Journal.open(':memory:');
    journal.append(
      { type: 'session.started', session: 'ses_boopy', actor: 'person', data: { device: null } },
      'evt_boopy',
      AT,
    );
    const tasks = new TaskStore(journal);
    open(tasks);
    tasks.receive(lesson, AT);
    const audio = 'd'.repeat(64);
    const answer = {
      eventId: 'evt_spoken',
      sessionId: SESSION,
      taskId: 'tsk_sahara_later',
      expectedRevision: 1,
      audioSha256: audio,
    };
    assert.equal(tasks.checkAnswer(answer), undefined);
    const before = journal.all().length;
    assert.equal(kind(tasks.checkAnswer({ ...answer, taskId: 'tsk_missing' })), 'unknown_task');
    assert.equal(
      kind(tasks.checkAnswer({ ...answer, sessionId: 'sess_other' })),
      'session_mismatch',
    );
    assert.equal(kind(tasks.checkAnswer({ ...answer, expectedRevision: 0 })), 'stale_revision');
    assert.equal(kind(tasks.checkAnswer({ ...answer, expectedRevision: 5 })), 'stale_revision');
    assert.equal(
      kind(tasks.checkAnswer({ ...answer, eventId: 'evt_boopy' })),
      'duplicate_conflict',
    );
    assert.equal(
      kind(tasks.checkAnswer({ ...answer, eventId: 'evt_open_sahara' })),
      'duplicate_conflict',
    );
    assert.equal(journal.all().length, before);
    const recorded = tasks.act(
      {
        eventId: 'evt_spoken',
        sessionId: SESSION,
        taskId: 'tsk_sahara_later',
        expectedRevision: 1,
        action: {
          type: 'voice_reply',
          text: 'Two camels.',
          recognitionUncertain: true,
          audioSha256: audio,
          recognizer: 'fake speech',
        },
      },
      AT,
    );
    assert.equal(recorded.status, 'accepted');
    assert.deepEqual(tasks.checkAnswer(answer), recorded);
    for (const other of [
      { ...answer, expectedRevision: 2 },
      { ...answer, sessionId: 'sess_other' },
      { ...answer, taskId: 'tsk_manual' },
      { ...answer, audioSha256: 'e'.repeat(64) },
    ])
      assert.equal(kind(tasks.checkAnswer(other)), 'duplicate_conflict');
    const retry = {
      eventId: 'evt_retry_now',
      sessionId: SESSION,
      taskId: 'tsk_sahara_later',
      expectedRevision: 2,
      action: { type: 'retry' },
    };
    assert.equal(kind(tasks.act(retry, AT)), 'accepted');
    assert.equal(
      kind(tasks.checkAnswer({ ...answer, eventId: 'evt_retry_now', expectedRevision: 2 })),
      'duplicate_conflict',
    );
    assert.equal(
      kind(
        tasks.act(
          { ...retry, eventId: 'evt_cancel_now', expectedRevision: 3, action: { type: 'cancel' } },
          AT,
        ),
      ),
      'accepted',
    );
    const count = journal.all().length;
    assert.equal(
      kind(tasks.checkAnswer({ ...answer, eventId: 'evt_after', expectedRevision: 4 })),
      'cancelled',
    );
    assert.equal(journal.all().length, count);
  });

  it('refuses an answer when the task asks for none, appending nothing', () => {
    const journal = Journal.open(':memory:');
    const tasks = new TaskStore(journal);
    const answer = {
      eventId: 'evt_spoken',
      sessionId: SESSION,
      taskId: 'tsk_capture',
      expectedRevision: 1,
      audioSha256: 'd'.repeat(64),
    };
    // A statement: the result shows a line and asks nothing.
    const statement = tasks.openWithResult(
      opening,
      {
        ...first,
        components: [
          { type: 'subject', sourceId: 'src_sahara_still', maskId: null },
          { type: 'dialogue', text: 'A desert photo.', evidenceIds: ['ev_photo'] },
        ],
      },
      AT,
    );
    assert.equal(statement.status, 'accepted');
    const before = journal.all().length;
    assert.equal(kind(tasks.checkAnswer(answer)), 'answer_not_offered');
    // A stale answer still learns that the task changed.
    assert.equal(kind(tasks.checkAnswer({ ...answer, expectedRevision: 0 })), 'stale_revision');
    // A task still waiting for its first result asks for nothing either.
    tasks.open({ ...opening, eventId: 'evt_open_bare', taskId: 'tsk_bare' }, AT);
    assert.equal(
      kind(tasks.checkAnswer({ ...answer, taskId: 'tsk_bare', expectedRevision: 0 })),
      'answer_not_offered',
    );
    const asking = tasks.openWithResult(
      { ...opening, eventId: 'evt_open_asking', taskId: 'tsk_asking' },
      { ...first, resultId: 'res_asking', taskId: 'tsk_asking' },
      AT,
    );
    assert.equal(asking.status, 'accepted');
    const asked = { ...answer, taskId: 'tsk_asking' };
    assert.equal(tasks.checkAnswer(asked), undefined);
    const wrong = tasks.act(
      {
        eventId: 'evt_wrong',
        sessionId: SESSION,
        taskId: 'tsk_asking',
        expectedRevision: 1,
        action: { type: 'wrong_subject' },
      },
      AT,
    );
    assert.equal(wrong.status, 'accepted');
    const after = journal.all().length;
    // Wrong item clears the parts, so the answer it offered is gone too.
    assert.equal(kind(tasks.checkAnswer({ ...asked, expectedRevision: 2 })), 'answer_not_offered');
    assert.equal(journal.all().length, after);
    // The bare opening, the asking task's opening and result, and the correction; no answer check.
    assert.equal(after, before + 4);
  });
});

describe('a reply from a named connection', () => {
  const NONCE = 'b'.repeat(32);
  const TASK = 'tsk_sahara_later';
  const REQUEST = {
    eventId: 'evt_request_one',
    taskId: TASK,
    sessionId: SESSION,
    connectionId: 'con_study',
    requestId: 'trq_one',
    nonce: NONCE,
  };
  const LINE = {
    type: 'dialogue',
    text: 'A camel at rest. Where was this?',
    evidenceIds: ['ev_camel'],
  };
  const PROMPT = { type: 'voice_reply', prompt: 'Answer.' };

  /** A task with Boopy's parts, the person's named connection, and one request for revision 1. */
  function requested(journal = Journal.open(':memory:')) {
    const tasks = new TaskStore(journal);
    assert.equal(open(tasks).status, 'accepted');
    assert.equal(tasks.receive(lesson, AT).status, 'accepted');
    const connected = tasks.connect(
      { eventId: 'evt_connect_study', connectionId: 'con_study', label: 'My study chat' },
      AT,
    );
    assert.equal(connected.status, 'accepted');
    const prepared = tasks.prepareRequest(REQUEST, AT);
    assert.equal(prepared.status, 'accepted');
    return { tasks, journal, prepared };
  }

  type Body = Record<string, unknown>;
  const reply = (change: (body: Body) => Body = (body) => body) =>
    JSON.stringify(
      change({
        type: 'boopy.task-reply',
        version: 1,
        requestId: 'trq_one',
        taskId: TASK,
        baseTaskRevision: 1,
        source: SOURCE,
        nonce: NONCE,
        previousReplyId: null,
        components: [LINE, PROMPT],
      }),
    );
  const digest = (text: string) => createHash('sha256').update(text).digest('hex');

  it('prepares one request per task revision and keeps only the digest of its nonce', () => {
    const { tasks, journal, prepared } = requested();
    if (prepared.status !== 'accepted') return;
    assert.equal(prepared.requestId, 'trq_one');
    assert.ok(prepared.file.includes(NONCE));
    const event = journal.all().find((entry) => entry.type === 'task.request-prepared');
    assert.ok(event?.type === 'task.request-prepared');
    assert.equal(event.data.nonceSha256, digest(NONCE));
    assert.equal(event.data.fileSha256, prepared.fileSha256);
    assert.equal(JSON.stringify(journal.all()).includes(NONCE), false);
    const again = tasks.prepareRequest(
      { ...REQUEST, eventId: 'evt_request_two', requestId: 'trq_two' },
      AT,
    );
    assert.deepEqual(again, { status: 'rejected', code: 'request_exists', requestId: 'trq_one' });
    const nowhere = tasks.prepareRequest(
      { ...REQUEST, eventId: 'evt_request_three', requestId: 'trq_three', connectionId: 'con_x' },
      AT,
    );
    assert.equal(nowhere.status === 'rejected' && nowhere.code, 'unknown_connection');
  });

  it('gives an identical retry the same file and journals nothing; any other change conflicts', () => {
    const { tasks, journal, prepared } = requested();
    const count = journal.all().length;
    assert.deepEqual(tasks.prepareRequest(REQUEST, AT), prepared);
    for (const change of [
      { nonce: 'c'.repeat(32) },
      { connectionId: 'con_other' },
      { taskId: 'tsk_other' },
      { eventId: 'evt_request_again' },
    ]) {
      const other = tasks.prepareRequest({ ...REQUEST, ...change }, AT);
      assert.equal(other.status === 'rejected' && other.code, 'duplicate_conflict');
    }
    assert.equal(journal.all().length, count);
  });

  it('writes the model’s confidence into the request when Boopy knows it', () => {
    const tasks = store();
    assert.equal(open(tasks).status, 'accepted');
    assert.equal(tasks.receive(lesson, AT).status, 'accepted');
    tasks.connect({ eventId: 'evt_connect_study', connectionId: 'con_study', label: 'Study' }, AT);
    const known = tasks.prepareRequest({ ...REQUEST, subjectConfidence: 0.85 }, AT);
    assert.ok(known.status === 'accepted');
    assert.equal(JSON.parse(known.file).task.subject.confidence, 0.85);
    assert.deepEqual(tasks.prepareRequest({ ...REQUEST, subjectConfidence: 0.85 }, AT), known);
  });

  it('cannot give a retry its file once the task moved on', () => {
    const { tasks } = requested();
    const retry = { type: 'retry' } as const;
    tasks.act(
      {
        eventId: 'evt_retry',
        sessionId: SESSION,
        taskId: TASK,
        expectedRevision: 1,
        action: retry,
      },
      AT,
    );
    const late = tasks.prepareRequest(REQUEST, AT);
    assert.equal(late.status === 'rejected' && late.code, 'request_unavailable');
  });

  it('asks nothing for a task without Boopy’s parts', () => {
    const tasks = store();
    assert.equal(open(tasks).status, 'accepted');
    tasks.connect({ eventId: 'evt_connect_study', connectionId: 'con_study', label: 'Study' }, AT);
    const prepared = tasks.prepareRequest({ ...REQUEST }, AT);
    assert.equal(prepared.status === 'rejected' && prepared.code, 'request_unavailable');
  });

  it('takes a matching reply as the next revision through the named connection, still not sent', () => {
    const { tasks, journal } = requested();
    const content = reply();
    const matched = tasks.matchReply(content, AT);
    assert.equal(matched.status, 'accepted');
    if (matched.status !== 'accepted') return;
    assert.equal(matched.task.revision, 2);
    assert.equal(matched.task.delivery, 'not-sent');
    assert.equal(matched.task.continuity, 'local-only');
    assert.deepEqual(matched.task.reply, { connection: 'My study chat' });
    // The subject and its chip stay Boopy's; the connection never saw the picture.
    assert.deepEqual(matched.task.components, [
      lesson.components[0],
      lesson.components[1],
      LINE,
      PROMPT,
      { type: 'status', code: 'not-sent' },
    ]);
    const event = journal.all().at(-1);
    assert.ok(event?.type === 'task.reply-matched');
    assert.equal(event.actor, 'person');
    assert.equal(event.data.fileSha256, digest(content));
    assert.equal(event.data.authorship, 'claimed-by-file');
    const count = journal.all().length;
    assert.deepEqual(tasks.matchReply(content, AT), matched);
    assert.equal(journal.all().length, count);
    assert.deepEqual(new TaskStore(journal).get(TASK), matched.task);
  });

  it('records a reply that does not match by its digest and a code, and changes nothing', () => {
    const cases: [string, (body: Body) => Body][] = [
      ['reply_invalid', (body) => ({ ...body, delivery: 'sent' })],
      ['reply_invalid', (body) => ({ ...body, components: [PROMPT] })],
      ['reply_invalid', (body) => ({ ...body, components: [{ ...LINE, evidenceIds: ['ev_x'] }] })],
      ['nonce_mismatch', (body) => ({ ...body, nonce: 'c'.repeat(32) })],
      ['source_mismatch', (body) => ({ ...body, source: { ...SOURCE, sha256: 'd'.repeat(64) } })],
      ['stale_revision', (body) => ({ ...body, baseTaskRevision: 0 })],
    ];
    for (const [code, change] of cases) {
      const { tasks, journal } = requested();
      const before = tasks.get(TASK);
      const content = reply(change);
      const refused = tasks.matchReply(content, AT);
      assert.equal(refused.status === 'rejected' && refused.code, code, code);
      assert.equal(tasks.get(TASK)?.revision, before?.revision, code);
      assert.deepEqual(tasks.get(TASK)?.components, before?.components, code);
      const event = journal.all().at(-1);
      assert.ok(event?.type === 'task.reply-rejected', code);
      assert.deepEqual([event.data.fileSha256, event.data.code], [digest(content), code]);
      assert.equal(JSON.stringify(event).includes('camel at rest'), false, code);
    }
  });

  it('refuses a reply once the task moved on, was cancelled, or already took another reply', () => {
    const moved = requested();
    moved.tasks.act(
      {
        eventId: 'evt_retry',
        sessionId: SESSION,
        taskId: TASK,
        expectedRevision: 1,
        action: { type: 'retry' },
      },
      AT,
    );
    const late = moved.tasks.matchReply(reply(), AT);
    assert.equal(late.status === 'rejected' && late.code, 'stale_revision');
    const cancelled = requested();
    cancelled.tasks.act(
      {
        eventId: 'evt_cancel',
        sessionId: SESSION,
        taskId: TASK,
        expectedRevision: 1,
        action: { type: 'cancel' },
      },
      AT,
    );
    const closed = cancelled.tasks.matchReply(reply(), AT);
    assert.equal(closed.status === 'rejected' && closed.code, 'cancelled');
    const answered = requested();
    assert.equal(answered.tasks.matchReply(reply(), AT).status, 'accepted');
    const other = reply((body) => ({ ...body, components: [LINE] }));
    const second = answered.tasks.matchReply(other, AT);
    assert.equal(second.status === 'rejected' && second.code, 'duplicate_conflict');
    assert.equal(answered.tasks.get(TASK)?.revision, 2);
  });

  it('journals nothing for a file it cannot read or a request it never prepared', () => {
    const { tasks, journal } = requested();
    const count = journal.all().length;
    const unread = tasks.matchReply('Here is my reply.', AT);
    assert.equal(unread.status === 'rejected' && unread.code, 'reply_unreadable');
    const stranger = tasks.matchReply(
      reply((body) => ({ ...body, requestId: 'trq_other' })),
      AT,
    );
    assert.equal(stranger.status === 'rejected' && stranger.code, 'unknown_request');
    assert.equal(journal.all().length, count);
  });
});
