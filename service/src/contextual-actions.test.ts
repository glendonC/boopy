import assert from 'node:assert/strict';
import { it } from 'node:test';
import { Boopy } from './boopy.ts';
import { type ContextualAction, type ContextualActionSelection, SessionView } from './contracts.ts';
import { evidenceRecords } from './evidence-contract.ts';
import { headsetApp } from './http/headset.ts';
import { FixtureInterpreter } from './interpret/fixture.ts';
import type { InterpretInput } from './interpret/interpreter.ts';
import { frameOf, startRequest, testBoopy } from './testing.ts';

const words = 'Describe this synthetic photograph.';
const answer = 'This may show a synthetic desert photograph.';
function setup(followUps = true, firstQuestion = 'Save it') {
  const inputs: InterpretInput[] = [];
  const fixture = new FixtureInterpreter();
  const test = testBoopy({
    interpreter: {
      provider: 'fixture',
      model: 'synthetic-contextual-actions',
      async interpret(input) {
        inputs.push(input);
        const result = await fixture.interpret(input);
        result.output.response = input.selectedReference
          ? 'The recorded photo may show dunes.'
          : answer;
        if (followUps)
          result.output.followUps = [
            { question: firstQuestion },
            { question: 'What does the background show?' },
          ];
        return result;
      },
    },
  });
  let mediaWrites = 0;
  const put = test.deps.media.put.bind(test.deps.media);
  test.deps.media.put = (...args) => {
    mediaWrites++;
    return put(...args);
  };
  const app = headsetApp(test.boopy, { logger: false });
  return {
    ...test,
    app,
    inputs,
    mediaWrites: () => mediaWrites,
    close: async () => {
      await app.close();
      test.journal.close();
    },
  };
}
function selection(view: SessionView, action: ContextualAction): ContextualActionSelection {
  assert.ok(view.dialogue);
  return {
    utteranceId: view.dialogue.utteranceId,
    responseAt: view.dialogue.at,
    actionId: action.id,
  };
}
function request(view: SessionView, action: ContextualAction) {
  return {
    speech: { text: action.question },
    cues: action.targetItemId === null ? {} : { targetItemId: action.targetItemId },
    selection: selection(view, action),
  };
}

it('selected model follow-ups remain informational with exact response provenance, persisted selection and continuing history', async () => {
  const test = setup();
  try {
    const first = await test.boopy.start({
      ...startRequest(words),
      frame: { ...frameOf(), source: 'displayed-image', timestampTrusted: false },
      requestId: 'c3aa606d-f62a-425c-b8a9-228c617c1b54',
    });
    assert.equal(first.dialogue?.text, answer);
    const action = first.dialogue?.actions?.[0];
    assert.ok(action);
    assert.equal(action.question, 'What does the background show?');
    assert.equal(
      first.dialogue?.actions?.some((item) => item.question === 'Save it'),
      false,
    );
    assert.equal(action.targetItemId, first.referentId);
    assert.equal(action.observationId, first.observations[0]?.id);
    const expectedSelection = selection(first, action);
    const response = await test.app.inject({
      method: 'POST',
      url: `/v1/sessions/${first.id}/utterances`,
      payload: request(first, action),
    });
    assert.equal(response.statusCode, 200);
    const second = SessionView.parse(response.json());
    assert.equal(second.state, 'review');
    assert.equal(second.committed, null);
    assert.equal(test.inputs.length, 2);
    assert.equal(test.inputs[1]?.said, action.question);
    assert.equal(test.inputs[1]?.selectedReference?.itemId, action.targetItemId);
    assert.deepEqual(test.inputs[1]?.conversation, [
      {
        speaker: 'person',
        text: words,
        utteranceId: first.utterances[0]?.id,
        observationId: action.observationId,
        inputSource: 'typed',
      },
      {
        speaker: 'boopy',
        text: answer,
        utteranceId: first.utterances[0]?.id,
        observationId: action.observationId,
      },
    ]);
    assert.ok(
      test.inputs[1]?.contextualItems?.some(
        (item) =>
          first.items.some((existing) => existing.id === item.id) &&
          item.status === 'proposed' &&
          item.origin === 'model',
      ),
    );
    assert.equal(
      second.items.some((item) => item.status === 'confirmed' || item.origin === 'person'),
      false,
    );
    const heard = test.journal
      .all()
      .filter((event) => event.type === 'utterance.heard')
      .at(-1);
    assert.ok(heard?.type === 'utterance.heard');
    assert.equal(heard.data.source, 'suggestion');
    assert.equal(heard.data.evidenceSource, 'displayed-image');
    assert.equal(second.observations.length, first.observations.length);
    assert.deepEqual(heard.data.selection, expectedSelection);
    assert.deepEqual(heard.data.reading, { kind: 'ask' });
    const count = test.journal.all().length;
    await assert.rejects(
      test.boopy.utter(first.id, request(first, action)),
      (error) => error instanceof Error && 'code' in error && error.code === 'stale_suggestion',
    );
    assert.equal(test.journal.all().length, count);
    assert.equal(test.inputs.length, 2);
    const replay = new Boopy(test.deps).view(first.id);
    assert.deepEqual(replay.dialogue, second.dialogue);
    const nextAction = second.dialogue?.actions?.[0];
    assert.ok(nextAction);
    const third = await test.boopy.utter(first.id, request(second, nextAction));
    assert.equal(third.state, 'review');
    assert.ok(
      test.inputs[2]?.conversation?.some(
        (turn) =>
          turn.speaker === 'person' &&
          turn.text === action.question &&
          turn.inputSource === 'suggestion' &&
          turn.observationId === action.observationId,
      ),
    );
    assert.ok(
      test.inputs[2]?.conversation?.some(
        (turn) => turn.speaker === 'boopy' && turn.text === second.dialogue?.text,
      ),
    );
    const saved = test.boopy.commit(first.id);
    assert.ok(saved.committed);
    const pkg = test.boopy.package(saved.committed.packageId);
    assert.ok(pkg);
    const provenance = pkg.provenance.utterances.find(
      (utterance) => utterance.source === 'suggestion',
    );
    assert.deepEqual(provenance?.selection, expectedSelection);
    assert.equal(provenance?.text, action.question);
    assert.equal(provenance?.evidenceSource, 'displayed-image');
    const selectedAnswer = evidenceRecords(pkg).find(
      (record) => record.statement === second.dialogue?.text,
    );
    assert.ok(selectedAnswer);
    assert.equal(selectedAnswer.sourceContext, 'displayed-image');
    assert.equal(pkg.intent?.said, words);
    assert.equal(
      evidenceRecords(pkg).some(
        (record) => record.verification === 'confirmed' || record.verification === 'authored',
      ),
      false,
    );
  } finally {
    await test.close();
  }
});

it('rejects stale, cross-session and altered selected actions before any journal or media mutation', async () => {
  const test = setup();
  try {
    const first = await test.boopy.start({
      ...startRequest(words),
      requestId: 'a34ee668-a4bd-49c4-b147-84f2a05fe12e',
    });
    const other = await test.boopy.start({
      ...startRequest('Another synthetic session.'),
      requestId: 'ac9ee668-a4bd-49c4-b147-84f2a05fe12e',
    });
    const action = first.dialogue?.actions?.[0];
    assert.ok(action);
    const valid = request(first, action);
    const invalid = [
      { ...valid, selection: { ...valid.selection, responseAt: 'synthetic-wrong-time' } },
      { ...valid, selection: { ...valid.selection, utteranceId: 'synthetic-wrong-utterance' } },
      { ...valid, selection: { ...valid.selection, actionId: 'synthetic-wrong-action' } },
      { ...valid, speech: { text: 'Altered question.' } },
      { ...valid, speech: { text: 'Save it' } },
      { ...valid, cues: { targetItemId: 'synthetic-wrong-target' } },
      { ...valid, cues: {} },
      { ...valid, frame: frameOf() },
      { ...valid, attention: { source: 'unknown', scope: 'target', evidence: 'none' } },
      { ...valid, cues: { ...valid.cues, gaze: { point: { x: 0.4, y: 0.5 }, onSurface: true } } },
    ];
    for (const payload of invalid) {
      const before = test.journal.all().length;
      const writes = test.mediaWrites();
      const response = await test.app.inject({
        method: 'POST',
        url: `/v1/sessions/${first.id}/utterances`,
        payload,
      });
      assert.equal(response.statusCode, 409);
      assert.equal(response.json().error.code, 'stale_suggestion');
      assert.equal(test.journal.all().length, before);
      assert.equal(test.mediaWrites(), writes);
    }
    const before = test.journal.all().length;
    const writes = test.mediaWrites();
    const cross = await test.app.inject({
      method: 'POST',
      url: `/v1/sessions/${other.id}/utterances`,
      payload: valid,
    });
    assert.equal(cross.statusCode, 409);
    assert.equal(test.journal.all().length, before);
    assert.equal(test.mediaWrites(), writes);
    assert.equal(test.inputs.length, 2);
  } finally {
    await test.close();
  }
});

it('old provider outputs without follow-ups retain their exact answer and produce no actions', async () => {
  const test = setup(false);
  try {
    const view = await test.boopy.start({
      ...startRequest(words),
      requestId: 'a34ee668-a4bd-49c4-b147-84f2a05fe12e',
    });
    assert.equal(view.dialogue?.text, answer);
    assert.deepEqual(view.dialogue?.actions ?? [], []);
    assert.equal(
      view.items.every((item) => item.status === 'proposed'),
      true,
    );
  } finally {
    await test.close();
  }
});

it('history attributes a targeted answer to its original evidence while retaining the supplied view on the person turn', async () => {
  const test = setup();
  try {
    const first = await test.boopy.start({
      ...startRequest(words),
      requestId: 'da4ee668-a4bd-49c4-b147-84f2a05fe12e',
    });
    const target = first.items.find((item) => item.id === first.referentId);
    assert.ok(target?.grounding.observationId);
    const targetedWords = 'What does this photograph show?';
    const second = await test.boopy.utter(first.id, {
      speech: { text: targetedWords },
      cues: { targetItemId: target.id },
      frame: { ...frameOf('korean-notes.jpg'), source: 'displayed-image', timestampTrusted: false },
    });
    assert.equal(second.observations.length, 2);
    const newerObservation = second.observations.at(-1)?.id;
    assert.ok(newerObservation);
    assert.notEqual(newerObservation, target.grounding.observationId);
    assert.equal(test.inputs[1]?.selectedReference?.observationId, target.grounding.observationId);
    const action = second.dialogue?.actions?.[0];
    assert.ok(action);
    await test.boopy.utter(first.id, request(second, action));
    const history = test.inputs[2]?.conversation;
    assert.ok(history);
    const question = history.find(
      (turn) => turn.speaker === 'person' && turn.text === targetedWords,
    );
    const reply = history.find(
      (turn) => turn.speaker === 'boopy' && turn.text === second.dialogue?.text,
    );
    assert.ok(question);
    assert.ok(reply);
    assert.equal(question.observationId, newerObservation);
    assert.equal(reply.observationId, target.grounding.observationId);
    assert.equal(question.utteranceId, reply.utteranceId);
    assert.equal(question.inputSource, 'typed');
  } finally {
    await test.close();
  }
});

it('a modal question about saving stays informational and never executes a commit', async () => {
  const test = setup(true, 'Can you save this?');
  try {
    const first = await test.boopy.start({
      ...startRequest(words),
      requestId: '95a6cf96-8baf-4499-bd81-0b0d90812482',
    });
    const action = first.dialogue?.actions?.find((item) => item.question === 'Can you save this?');
    assert.ok(action);
    const view = await test.boopy.utter(first.id, request(first, action));
    assert.equal(view.state, 'review');
    assert.equal(view.committed, null);
    assert.equal(test.inputs.length, 2);
    const heard = test.journal
      .all()
      .filter((event) => event.type === 'utterance.heard')
      .at(-1);
    assert.ok(heard?.type === 'utterance.heard');
    assert.deepEqual(heard.data.reading, { kind: 'ask' });
    assert.equal(heard.data.source, 'suggestion');
    assert.equal(
      test.journal.all().some((event) => event.type === 'context.committed'),
      false,
    );
  } finally {
    await test.close();
  }
});
