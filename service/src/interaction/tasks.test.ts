import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Journal } from '../journal.ts';
import { TaskStore } from './tasks.ts';

const AT = '1970-01-01T00:00:00.000Z';
const SHA = 'a'.repeat(64);
const SOURCE = { sourceId: 'src_picture', sourceRevision: 1, sha256: SHA };
const SESSION = 'sess_owner';

function store() {
  return new TaskStore(Journal.open(':memory:'));
}

function open(tasks: TaskStore) {
  return tasks.open(
    {
      eventId: 'evt_open_picture',
      sessionId: SESSION,
      taskId: 'tsk_picture',
      source: SOURCE,
      intent: 'consult_source',
      utterance: 'What is in this picture?',
    },
    AT,
  );
}

describe('local interaction tasks', () => {
  it('saves a pending task without turning the proposal into a delivery', () => {
    const tasks = store();
    const opened = open(tasks);
    assert.equal(opened.status, 'accepted');
    if (opened.status !== 'accepted') return;
    assert.equal(opened.task.continuity, 'local-only');
    assert.equal(opened.task.delivery, 'not-sent');
    assert.equal(opened.task.revision, 0);
    assert.deepEqual(opened.task.components, [{ type: 'status', code: 'not-sent' }]);
    assert.equal(opened.task.utterance, 'What is in this picture?');
    assert.equal(opened.task.attempts.length, 0);
    assert.equal(opened.task.subjectCorrected, false);
    assert.deepEqual(open(tasks), opened);
  });

  it('records the person answering and still reports the task as not sent', () => {
    const tasks = store();
    assert.equal(open(tasks).status, 'accepted');
    const answer = tasks.act(
      {
        eventId: 'evt_answer',
        sessionId: SESSION,
        taskId: 'tsk_picture',
        expectedRevision: 0,
        action: {
          type: 'voice_reply',
          text: 'A camel is in this picture.',
          recognitionUncertain: true,
        },
      },
      AT,
    );
    assert.equal(answer.status, 'accepted');
    if (answer.status !== 'accepted') return;
    assert.equal(answer.task.revision, 1);
    assert.equal(answer.task.delivery, 'not-sent');
    assert.equal(answer.task.continuity, 'local-only');
    assert.deepEqual(answer.task.attempts, [
      {
        eventId: 'evt_answer',
        text: 'A camel is in this picture.',
        recognitionUncertain: true,
        kind: 'practice-attempt',
      },
    ]);
    assert.deepEqual(answer.task.components, [{ type: 'status', code: 'not-sent' }]);
    assert.deepEqual(
      tasks.act(
        {
          eventId: 'evt_answer',
          sessionId: SESSION,
          taskId: 'tsk_picture',
          expectedRevision: 0,
          action: {
            type: 'voice_reply',
            text: 'A camel is in this picture.',
            recognitionUncertain: true,
          },
        },
        AT,
      ),
      answer,
    );
  });

  it('refuses a stale action and leaves the unsent task unchanged', () => {
    const tasks = store();
    assert.equal(open(tasks).status, 'accepted');
    const stale = tasks.act(
      {
        eventId: 'evt_stale',
        sessionId: SESSION,
        taskId: 'tsk_picture',
        expectedRevision: 1,
        action: { type: 'wrong_subject' },
      },
      AT,
    );
    assert.equal(stale.status, 'rejected');
    if (stale.status !== 'rejected') return;
    assert.equal(stale.code, 'stale_revision');
    assert.equal(stale.task?.revision, 0);
    assert.equal(stale.task?.delivery, 'not-sent');
    assert.equal(stale.task?.subjectCorrected, false);
  });
});
