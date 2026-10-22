import assert from 'node:assert/strict';
import { it } from 'node:test';
import { AttentionInput } from './contracts.ts';
import { evidenceRecords } from './evidence-contract.ts';
import { headsetApp } from './http/headset.ts';
import { FixtureInterpreter } from './interpret/fixture.ts';
import type { InterpretInput } from './interpret/interpreter.ts';
import { Projection } from './session.ts';
import { frameOf, startRequest, testBoopy } from './testing.ts';

function setup(answer = true) {
  const inputs: InterpretInput[] = [];
  const fixture = new FixtureInterpreter();
  const test = testBoopy({
    interpreter: {
      provider: 'fixture',
      model: 'synthetic-target-question',
      async interpret(input) {
        inputs.push(input);
        const result = await fixture.interpret(input);
        if (input.selectedReference && answer)
          result.output.response = 'This recorded display may show a desert photograph.';
        return result;
      },
    },
  });
  let ocrCalls = 0;
  test.text.read = async () => {
    ocrCalls++;
    return [];
  };
  const app = headsetApp(test.boopy, { logger: false });
  return {
    ...test,
    app,
    inputs,
    ocrCalls: () => ocrCalls,
    close: async () => {
      await app.close();
      test.journal.close();
    },
  };
}

it('a targeted question uses its original recorded source despite a different supplied frame and leaves its claim proposed', async () => {
  const test = setup();
  try {
    await test.boopy.start(startRequest('Inspect this synthetic display.'));
    const started = test.journal.all().find((event) => event.type === 'session.started');
    assert.ok(started);
    const initial = test.boopy.view(started.session);
    const target = initial.items.find((item) => item.id === initial.referentId);
    assert.ok(target?.grounding.observationId);
    const words = 'What is this?';
    const result = await test.app.inject({
      method: 'POST',
      url: `/v1/sessions/${initial.id}/utterances`,
      payload: {
        speech: { text: words },
        cues: {
          targetItemId: target.id,
          pointer: { hand: 'right', point: { x: 0.99, y: 0.01 }, onSurface: true },
        },
        frame: {
          ...frameOf('korean-notes.jpg'),
          source: 'current-surroundings',
          timestampTrusted: false,
        },
        attention: {
          source: 'current-surroundings',
          scope: 'target',
          evidence: 'visual',
          ocrRequested: false,
          segmentationRequested: false,
        },
      },
    });
    assert.equal(result.statusCode, 200);
    const view = test.boopy.view(initial.id);
    assert.equal(test.inputs.length, 2);
    assert.equal(test.ocrCalls(), 1);
    const input = test.inputs[1];
    assert.ok(input?.selectedReference);
    assert.equal(input.said, words);
    assert.equal(input.selectedReference.itemId, target.id);
    assert.equal(input.selectedReference.observationId, target.grounding.observationId);
    assert.equal(input.selectedReference.verification, 'accepted');
    assert.equal(input.selectedReference.disposition, 'proposed');
    assert.deepEqual(input.selectedReference.box, target.grounding.box);
    assert.notDeepEqual(input.pointer, { x: 0.99, y: 0.01 });
    assert.equal(view.observations.length, 2);
    assert.equal(
      Projection.from(test.journal.all()).session(initial.id)?.interpretations.at(-1)
        ?.observationId,
      target.grounding.observationId,
    );
    assert.equal(view.utterances.at(-1)?.text, words);
    assert.equal(
      Projection.from(test.journal.all()).session(initial.id)?.utterances.at(-1)?.targetItemId,
      target.id,
    );
    assert.equal(view.referentId, target.id);
    assert.equal(view.items.find((item) => item.id === target.id)?.status, 'proposed');
    assert.equal(view.items.find((item) => item.id === target.id)?.note, target.note);
    assert.equal(view.notice, 'This recorded display may show a desert photograph.');
    assert.equal(input.pointer, null);
    assert.equal(input.gaze, null);
    assert.match(input.sourceContext?.selectionReason ?? '', /recorded.*current physical/);
    const answerItem = view.items.find((item) => item.label === 'Suggested answer');
    assert.ok(answerItem);
    assert.equal(answerItem.status, 'proposed');
    assert.equal(answerItem.origin, 'model');
    assert.equal(answerItem.confidence, null);
    assert.ok(
      view.relations.some(
        (relation) =>
          relation.from === answerItem.id && relation.to === target.id && relation.kind === 'about',
      ),
    );
    const saved = test.boopy.commit(initial.id);
    assert.ok(saved.committed);
    const exported = evidenceRecords(test.boopy.package(saved.committed.packageId)).find(
      (record) => record.itemId === answerItem.id,
    );
    assert.equal(exported?.verification, 'accepted');
    assert.equal(exported?.modelConfidence, null);

    assert.equal(
      test.journal.all().filter((event) => event.type === 'interaction.focused').length,
      0,
    );
  } finally {
    await test.close();
  }
});

it('a targeted question without visual evidence keeps exact question context without perception or confirming its target', async () => {
  const test = setup();
  try {
    await test.boopy.start({
      speech: { text: 'A synthetic personal memory.' },
      cues: {},
      attention: AttentionInput.parse({ source: 'unknown', scope: 'scene', evidence: 'none' }),
    });
    const started = test.journal.all().find((event) => event.type === 'session.started');
    assert.ok(started);
    const initial = test.boopy.view(started.session);
    const target = initial.items.find((item) => item.kind === 'utterance');
    assert.ok(target);
    const words = 'What does this mean?';
    await test.boopy.utter(initial.id, {
      speech: { text: words },
      cues: { targetItemId: target.id },
      attention: AttentionInput.parse({
        source: 'unknown',
        scope: 'target',
        evidence: 'none',
        ocrRequested: true,
        segmentationRequested: true,
      }),
    });
    const view = test.boopy.view(initial.id);
    assert.equal(test.inputs.length, 0);
    assert.equal(test.ocrCalls(), 0);
    assert.equal(view.observations.length, 0);
    const question = view.items.find((item) => item.kind === 'question');
    assert.equal(question?.statement, words);
    assert.equal(question?.origin, 'person');
    assert.equal(question?.confidence, null);
    assert.equal(view.utterances.at(-1)?.text, words);
    assert.equal(view.items.find((item) => item.id === target.id)?.note, target.note);
    assert.equal(view.items.find((item) => item.id === target.id)?.status, target.status);
  } finally {
    await test.close();
  }
});

it('evidence none on a visually sourced target forbids all additional perception', async () => {
  const test = setup();
  try {
    await test.boopy.start(startRequest('Inspect this synthetic display.'));
    const started = test.journal.all().find((event) => event.type === 'session.started');
    assert.ok(started);
    const initial = test.boopy.view(started.session);
    const target = initial.items.find((item) => item.id === initial.referentId);
    assert.ok(target);
    const words = 'Why is this important?';
    await test.boopy.utter(initial.id, {
      speech: { text: words },
      cues: { targetItemId: target.id },
      attention: AttentionInput.parse({
        source: 'unknown',
        scope: 'target',
        evidence: 'none',
        ocrRequested: true,
        segmentationRequested: true,
      }),
    });
    const view = test.boopy.view(initial.id);
    assert.equal(test.inputs.length, 1);
    assert.equal(test.ocrCalls(), 1);
    assert.equal(view.observations.length, 1);
    assert.equal(
      view.items.find((item) => item.kind === 'question' && item.origin === 'person')?.statement,
      words,
    );
    assert.equal(view.items.find((item) => item.id === target.id)?.status, 'proposed');
    assert.equal(view.items.find((item) => item.id === target.id)?.note, target.note);
  } finally {
    await test.close();
  }
});

it('a provider missing direct response returns an honest fallback and creates no answer or personal note', async () => {
  const test = setup(false);
  try {
    await test.boopy.start(startRequest('Inspect this synthetic display.'));
    const started = test.journal.all().find((event) => event.type === 'session.started');
    assert.ok(started);
    const initial = test.boopy.view(started.session);
    const target = initial.items.find((item) => item.id === initial.referentId);
    assert.ok(target);
    await test.boopy.utter(initial.id, {
      speech: { text: 'What is this?' },
      cues: { targetItemId: target.id },
    });
    const view = test.boopy.view(initial.id);
    assert.equal(
      view.notice,
      "I couldn't answer that from the recorded view. Could you rephrase your question?",
    );
    assert.equal(
      view.items.some((item) => item.label === 'Suggested answer'),
      false,
    );
    assert.equal(view.items.find((item) => item.id === target.id)?.note, target.note);
    assert.equal(view.items.find((item) => item.id === target.id)?.status, 'proposed');
  } finally {
    await test.close();
  }
});
