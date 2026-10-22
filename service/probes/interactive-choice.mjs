/** Fictional-only, explicit-run probe. Importing never calls a provider. */
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { OllamaInterpreter } from '../src/interpret/ollama.ts';
import { startRequest, testBoopy } from '../src/testing.ts';

export function interactiveChoiceRequest() {
  return {
    ...startRequest(
      'This is a fictional picture rehearsal, not a real trip. Ask which short description I want, using a choice card with two options: Name the scene in Korean, or Describe its colors in Korean. Each option value must exactly equal its visible label. For the first reply, response must exactly equal choice.prompt: one concise question only, without a separate preface. Do not infer a location or personal experience.',
    ),
    requestId: '11111111-1111-4111-8111-111111111111',
  };
}

export async function probeInteractiveChoice(interpreter) {
  const inputs = [];
  const timedCalls = [];
  const tracked = {
    provider: interpreter.provider,
    model: interpreter.model,
    async interpret(input, signal) {
      inputs.push(input);
      const started = performance.now();
      try {
        return await interpreter.interpret(input, signal);
      } finally {
        timedCalls.push(Math.round(performance.now() - started));
      }
    },
  };
  const { boopy, journal } = testBoopy({ interpreter: tracked });
  try {
    const first = await boopy.start(interactiveChoiceRequest());
    assert.equal(inputs.length, 1, 'Expected one initial interpretation.');
    const choice = first.dialogue?.choice;
    assert.ok(choice, 'Real provider did not return a usable choice card.');
    assert.equal(
      first.dialogue.text.trim(),
      choice.prompt.trim(),
      'Choice repeated or disagreed with caption.',
    );
    const option = choice.options[0];
    assert.ok(option);
    const binding = {
      utteranceId: first.dialogue.utteranceId,
      responseAt: first.dialogue.at,
      cardId: choice.id,
      optionId: option.id,
    };
    const originalEvidence = first.items.map(({ id, status, origin }) => ({ id, status, origin }));
    const selected = await boopy.selectChoice(first.id, binding);
    assert.equal(inputs.length, 1, 'Selection unexpectedly called interpreter.');
    assert.equal(selected.dialogue.choice.selectedOptionId, option.id);
    assert.deepEqual(
      selected.items.map(({ id, status, origin }) => ({ id, status, origin })),
      originalEvidence,
      'Selection changed evidence verification.',
    );
    const final = await boopy.submitChoice(first.id, binding);
    assert.equal(inputs.length, 2, 'Submission must call interpreter exactly once.');
    assert.equal(inputs[1].inputSource, 'choice');
    assert.equal(inputs[1].said, `${choice.prompt}\nSelected: ${option.value}`);
    assert.ok(final.dialogue?.text?.trim(), 'Missing validated next reply.');
    return {
      synthetic: true,
      initialSessionView: first,
      selectedSessionView: selected,
      finalSessionView: final,
      provider: interpreter.provider,
      model: interpreter.model,
      interpreterCalls: inputs.length,
      selectionInterpreterCalls: 0,
      submissionIncludesBoundValue: true,
      selectionPreservesEvidenceStatus: true,
      externalDelivery: 'not-attempted',
      wallMs: timedCalls,
      // All model text here derives exclusively from the manufactured fixture and prompt.
      choice: {
        prompt: choice.prompt,
        options: choice.options.map(({ label, value }) => ({ label, value })),
      },
      selectedValue: option.value,
      nextReply: final.dialogue.text,
    };
  } finally {
    journal.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await probeInteractiveChoice(
      new OllamaInterpreter({
        url: 'http://127.0.0.1:11434',
        model: 'qwen3.6:35b-a3b-nvfp4',
        timeoutMs: 55000,
        think: false,
      }),
    );
    console.log(JSON.stringify(result));
  } catch {
    console.error('Synthetic choice probe failed; no provider error content retained.');
    process.exitCode = 1;
  }
}
