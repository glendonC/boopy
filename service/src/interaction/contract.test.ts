import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Component, StatusCode, type TaskView, UserAction } from './contract.ts';

const proposal = {
  type: 'dialogue',
  text: 'A camel is in this picture.',
  evidenceIds: ['ev_picture'],
};

describe('interaction contract', () => {
  it('a proposal is not a person action', () => {
    assert.equal(UserAction.safeParse(proposal).success, false);
    assert.equal(Component.safeParse(proposal).success, true);
  });

  it('an outcome that was not delivered is reported as not sent', () => {
    assert.equal(StatusCode.parse('not-sent'), 'not-sent');
    assert.equal(StatusCode.safeParse('sent').success, false);
    const view = {
      taskId: 'tsk_picture',
      sessionId: 'sess_owner',
      revision: 0,
      source: {
        sourceId: 'src_picture',
        sourceRevision: 1,
        sha256: 'a'.repeat(64),
      },
      intent: 'consult_source',
      utterance: 'What is in this picture?',
      phase: 'open',
      continuity: 'local-only',
      delivery: 'not-sent',
      subjectCorrected: false,
      components: [{ type: 'status', code: 'not-sent' }],
      attempts: [],
      lastRejection: null,
    } satisfies TaskView;
    assert.equal(view.delivery, 'not-sent');
    assert.notEqual(view.components[0]?.type, 'voice_reply');
  });
});
