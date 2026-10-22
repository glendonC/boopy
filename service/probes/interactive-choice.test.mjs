import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FixtureInterpreter } from '../src/interpret/fixture.ts';
import { probeInteractiveChoice } from './interactive-choice.mjs';

test('fictional probe observes server-bound selection and explicit submission without extra inference', async () => {
  const fixture = new FixtureInterpreter();
  let calls = 0;
  const result = await probeInteractiveChoice({
    provider: 'fixture',
    model: 'synthetic-choice',
    async interpret(input) {
      calls++;
      const answer = await fixture.interpret(input);
      const output = {
        ...answer.output,
        response: calls === 1 ? 'What should I describe?' : 'The fictional image has warm colors.',
        choice:
          calls === 1
            ? {
                kind: 'choice',
                prompt: 'What should I describe?',
                options: [
                  { label: 'Colors', value: 'Colors' },
                  { label: 'Shapes', value: 'Shapes' },
                ],
              }
            : null,
      };
      return { output, raw: JSON.stringify(output) };
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.selectionInterpreterCalls, 0);
  assert.equal(result.submissionIncludesBoundValue, true);
  assert.equal(result.selectedValue, 'Colors');
  assert.equal(result.provider, 'fixture');
  assert.equal(result.externalDelivery, 'not-attempted');
});

test('missing actual provider choice is failure, never replaced by a fabricated widget', async () => {
  await assert.rejects(probeInteractiveChoice(new FixtureInterpreter()), /usable choice card/);
});
