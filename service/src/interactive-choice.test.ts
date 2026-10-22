import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { it } from 'node:test';
import { Boopy } from './boopy.ts';
import { type ChoiceSelection, type SessionView, SessionView as View } from './contracts.ts';
import { headsetApp } from './http/headset.ts';
import { FixtureInterpreter } from './interpret/fixture.ts';
import type { InterpretInput } from './interpret/interpreter.ts';
import { ModelOutput, outputJsonSchema, parseModelText } from './interpret/output.ts';
import { SYSTEM_PROMPT } from './interpret/prompt.ts';
import { startRequest, testBoopy } from './testing.ts';

const requestFor = (words: string) => ({ ...startRequest(words), requestId: randomUUID() });

const choice = {
  kind: 'choice',
  prompt: 'Choose the next reply style.',
  options: [
    { label: 'Save it', value: 'Save it' },
    { label: 'Short explanation', value: 'Short explanation' },
  ],
} as const;
function setup(widget: unknown = choice, response: string = choice.prompt) {
  const inputs: InterpretInput[] = [];
  const fixture = new FixtureInterpreter();
  const test = testBoopy({
    interpreter: {
      provider: 'fixture',
      model: 'synthetic-choice',
      async interpret(input) {
        inputs.push(input);
        const result = await fixture.interpret(input);
        const output = ModelOutput.parse({
          ...result.output,
          response,
          choice: widget,
        });
        return { output, raw: JSON.stringify(output) };
      },
    },
  });
  return { ...test, inputs, app: headsetApp(test.boopy, { logger: false }) };
}
function binding(view: SessionView, index = 0): ChoiceSelection {
  const dialogue = view.dialogue;
  assert.ok(dialogue?.choice);
  const option = dialogue.choice.options[index];
  assert.ok(option);
  return {
    utteranceId: dialogue.utteranceId,
    responseAt: dialogue.at,
    cardId: dialogue.choice.id,
    optionId: option.id,
  };
}

it('selection persists through GET and replay without inference, evidence mutation or new media', async () => {
  const test = setup();
  try {
    const first = await test.boopy.start(requestFor('Describe this fictional picture.'));
    const request = binding(first);
    const beforeItems = structuredClone(first.items);
    const beforeObservations = structuredClone(first.observations);
    const response = await test.app.inject({
      method: 'POST',
      url: `/v1/sessions/${first.id}/choice-selection`,
      payload: request,
    });
    assert.equal(response.statusCode, 200);
    const selected = View.parse(response.json());
    assert.equal(selected.dialogue?.choice?.selectedOptionId, request.optionId);
    assert.equal(test.inputs.length, 1);
    assert.deepEqual(selected.items, beforeItems);
    assert.deepEqual(selected.observations, beforeObservations);
    const fetched = await test.app.inject({ method: 'GET', url: `/v1/sessions/${first.id}` });
    assert.deepEqual(fetched.json().dialogue, selected.dialogue);
    const replay = new Boopy(test.deps);
    assert.deepEqual(replay.view(first.id).dialogue, selected.dialogue);
    assert.equal(
      test.journal.all().filter((event) => event.type === 'interaction.choice-selected').length,
      1,
    );
  } finally {
    await test.app.close();
    test.journal.close();
  }
});

it('explicit streaming submit uses server-bound value as informational input and rejects replay', async () => {
  const test = setup();
  try {
    const first = await test.boopy.start(requestFor('Describe this fictional picture.'));
    const request = binding(first);
    await assert.rejects(test.boopy.submitChoice(first.id, request), {
      code: 'choice_not_selected',
    });
    await test.boopy.selectChoice(first.id, request);
    const response = await test.app.inject({
      method: 'POST',
      url: `/v1/sessions/${first.id}/choice-submit`,
      headers: { accept: 'application/x-ndjson' },
      payload: request,
    });
    assert.equal(response.statusCode, 200);
    const lines = response.body
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const terminal = lines.at(-1);
    assert.equal(terminal.type, 'result');
    const next = View.parse(terminal.view);
    assert.equal(test.inputs.length, 2);
    assert.equal(test.inputs[1]?.said, `${choice.prompt}\nSelected: Save it`);
    assert.equal(test.inputs[1]?.inputSource, 'choice');
    assert.equal(next.state, 'review');
    assert.equal(next.committed, null);
    assert.ok(next.items.every((item) => item.origin === 'model' && item.status === 'proposed'));
    assert.notEqual(next.dialogue?.choice?.id, first.dialogue?.choice?.id);
    assert.equal(next.dialogue?.choice?.selectedOptionId, null);
    const heard = test.journal.all().findLast((event) => event.type === 'utterance.heard');
    assert.ok(heard?.type === 'utterance.heard');
    assert.equal(heard.data.reading.kind, 'ask');
    assert.deepEqual(heard.data.choiceSelection, request);
    await assert.rejects(test.boopy.submitChoice(first.id, request), { code: 'stale_choice' });
    assert.equal(test.inputs.length, 2);
  } finally {
    await test.app.close();
    test.journal.close();
  }
});

it('rejects stale identities, foreign options, unselected alternatives and injected values', async () => {
  const test = setup();
  try {
    const first = await test.boopy.start(requestFor('Describe this fictional picture.'));
    const request = binding(first);
    for (const input of [
      { ...request, cardId: 'foreign' },
      { ...request, optionId: 'foreign' },
      { ...request, utteranceId: 'foreign' },
      { ...request, responseAt: 'foreign' },
    ])
      await assert.rejects(test.boopy.selectChoice(first.id, input), { code: 'stale_choice' });
    const other = await test.boopy.start(requestFor('Another fictional picture.'));
    await assert.rejects(test.boopy.selectChoice(other.id, request), { code: 'stale_choice' });
    await test.boopy.selectChoice(first.id, request);
    await assert.rejects(test.boopy.submitChoice(first.id, binding(first, 1)), {
      code: 'choice_not_selected',
    });
    const injected = await test.app.inject({
      method: 'POST',
      url: `/v1/sessions/${first.id}/choice-submit`,
      payload: { ...request, value: 'injected secret' },
    });
    assert.equal(injected.statusCode, 400);
    assert.equal(test.inputs.length, 2);
  } finally {
    await test.app.close();
    test.journal.close();
  }
});

it('drops unsupported, malformed and hidden-value widgets while preserving valid provider text', async () => {
  for (const widget of [
    { kind: 'html', html: '<button>Run</button>' },
    { ...choice, options: [] },
    { ...choice, options: [{ label: 'Visible', value: 'Hidden' }, choice.options[1]] },
    { ...choice, prompt: 'x'.repeat(161) },
  ]) {
    const test = setup(widget);
    try {
      const first = await test.boopy.start(requestFor('Describe this fictional picture.'));
      assert.equal(first.dialogue?.text, choice.prompt);
      assert.equal(first.dialogue?.choice, undefined);
    } finally {
      await test.app.close();
      test.journal.close();
    }
  }
  const fixture = await new FixtureInterpreter().interpret({
    said: '',
    language: 'en',
    scope: 'auto',
    gaze: null,
    pointer: null,
    image: Buffer.alloc(0),
    crop: null,
    text: [],
    decisions: [],
  });
  const parsed = parseModelText(
    JSON.stringify({
      ...fixture.output,
      response: 'Still readable.',
      choice: { kind: 'unsupported' },
    }),
  );
  assert.equal(parsed.response, 'Still readable.');
  assert.equal(parsed.choice, null);
  const mismatch = parseModelText(
    JSON.stringify({ ...fixture.output, response: 'Still readable.', choice }),
  );
  assert.equal(mismatch.response, 'Still readable.');
  assert.equal(mismatch.choice, null);
  // Observed real-provider failure: a valid choice with response:null must stay unusable.
  const absent = parseModelText(JSON.stringify({ ...fixture.output, response: null, choice }));
  assert.equal(absent.response, null);
  assert.equal(absent.choice, null);
  const matching = parseModelText(
    JSON.stringify({ ...fixture.output, response: `  ${choice.prompt}  `, choice }),
  );
  assert.deepEqual(matching.choice, choice);
  assert.doesNotThrow(() => outputJsonSchema());
});

it('the prompt choice example parses as one usable question rather than a null response', () => {
  const example = /For example: ("response":.*?})\. Do not add/.exec(SYSTEM_PROMPT)?.[1];
  assert.ok(example);
  const sample = JSON.parse(`{${example}}`);
  assert.equal(sample.response, sample.choice.prompt);
  assert.ok(sample.response.length <= 160);
  assert.equal(sample.choice.options.length, 2);
  assert.ok(
    sample.choice.options.every(
      (option: { label: string; value: string }) => option.label === option.value,
    ),
  );
});

it('uses one exact trimmed question or drops the optional choice while preserving caption text', async () => {
  for (const response of [
    `  ${choice.prompt}  `,
    'A separate preface.',
    choice.prompt.toUpperCase(),
  ]) {
    const test = setup(choice, response);
    try {
      const first = await test.boopy.start(requestFor('Describe this fictional picture.'));
      assert.equal(first.dialogue?.text, response.trim());
      if (response.trim() === choice.prompt) {
        assert.equal(first.dialogue?.choice?.prompt, first.dialogue?.text);
        assert.equal(first.dialogue?.choice?.options.length, 2);
      } else {
        assert.equal(first.dialogue?.choice, undefined);
      }
    } finally {
      await test.app.close();
      test.journal.close();
    }
  }
});

it('submitted model-authored personal wording is not packaged as the person’s authored account', async () => {
  const test = setup({
    ...choice,
    options: [{ label: 'I rode the animal', value: 'I rode the animal' }, choice.options[1]],
  });
  try {
    const original = 'Describe this fictional picture.';
    const first = await test.boopy.start(requestFor(original));
    const selected = binding(first);
    await test.boopy.selectChoice(first.id, selected);
    await test.boopy.submitChoice(first.id, selected);
    const committed = test.boopy.commit(first.id);
    const pkg = test.boopy.package(committed.committed?.packageId ?? '');
    assert.ok(pkg);
    assert.equal(pkg.intent?.said, original);
    assert.ok(
      pkg.items.every(
        (item) => item.verification !== 'authored' && item.verification !== 'confirmed',
      ),
    );
    const submitted = pkg.provenance.utterances.find((utterance) => utterance.source === 'choice');
    assert.deepEqual(submitted?.choiceSelection, selected);
    assert.equal(submitted?.text, `${choice.prompt}\nSelected: I rode the animal`);
  } finally {
    await test.app.close();
    test.journal.close();
  }
});

it('choice endpoints retain the headset loopback host boundary', async () => {
  const test = setup();
  try {
    const first = await test.boopy.start(requestFor('Describe this fictional picture.'));
    for (const route of ['choice-selection', 'choice-submit']) {
      const response = await test.app.inject({
        method: 'POST',
        url: `/v1/sessions/${first.id}/${route}`,
        headers: { host: 'untrusted.example' },
        payload: binding(first),
      });
      assert.equal(response.statusCode, 403);
    }
    assert.equal(test.inputs.length, 1);
    assert.equal(test.boopy.view(first.id).dialogue?.choice?.selectedOptionId, null);
  } finally {
    await test.app.close();
    test.journal.close();
  }
});
