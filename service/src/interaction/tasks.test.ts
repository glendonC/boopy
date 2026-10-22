import assert from 'node:assert/strict';
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
});
