import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AttentionInput } from './contracts.ts';
import { evidenceRecords } from './evidence-contract.ts';
import { FixtureInterpreter } from './interpret/fixture.ts';
import type { InterpretInput } from './interpret/interpreter.ts';
import { SYSTEM_PROMPT } from './interpret/prompt.ts';
import { Projection } from './session.ts';
import { startRequest, testBoopy } from './testing.ts';

const answer =
  'This appears to be a desert photograph. Which part of your experience would you like to describe in Korean?';
const requestId = '8bd2b7e0-4c6b-4e3c-a886-502d3f314ff9';
function setup(response: string | null = answer) {
  const fixture = new FixtureInterpreter();
  const inputs: InterpretInput[] = [];
  const test = testBoopy({
    interpreter: {
      provider: 'fixture',
      model: 'synthetic-first-conversation',
      async interpret(input) {
        inputs.push(input);
        const result = await fixture.interpret(input);
        result.output.response = response;
        return result;
      },
    },
  });
  return { ...test, inputs };
}

describe('first-turn conversational response', () => {
  it('retains an exact proposed answer with source/model attribution through commit and replay', async () => {
    const test = setup(`  ${answer}  `);
    try {
      const words = 'Help me talk about this in Korean';
      const view = await test.boopy.start({ ...startRequest(words), requestId });
      assert.equal(view.dialogue?.text, answer);
      assert.equal(test.inputs[0]?.said, words);
      assert.equal(test.inputs[0]?.selectedReference, undefined);
      const reply = view.items.find((item) => item.id.endsWith('.__reply'));
      assert.ok(reply);
      assert.equal(reply.statement, answer);
      assert.equal(reply.origin, 'model');
      assert.equal(reply.status, 'proposed');
      assert.equal(reply.confidence, null);
      assert.equal(reply.grounding.observationId, view.observations[0]?.id);
      const about = view.relations.find((relation) => relation.from === reply.id);
      assert.ok(view.referentId);
      assert.equal(about?.to, view.referentId);
      assert.equal(about?.kind, 'about');
      assert.equal(Projection.from(test.journal.all()).session(view.id)?.dialogue?.text, answer);
      const committed = test.boopy.commit(view.id);
      const pkg = test.boopy.package(committed.committed?.packageId ?? '');
      assert.ok(pkg);
      const record = evidenceRecords(pkg).find((item) => item.itemId === reply.id);
      assert.ok(record);
      assert.equal(record.verification, 'accepted');
      assert.equal(record.origin, 'model');
      assert.equal(record.modelConfidence, null);
      assert.equal(record.observationId, view.observations[0]?.id);
      assert.equal(record.utteranceId, view.utterances[0]?.id);
      assert.deepEqual(record.model, { provider: 'fixture', id: 'synthetic-first-conversation' });
      assert.equal(
        record.humanActions.some((action) => action.op === 'confirm'),
        false,
      );
      const replay = Projection.from(test.journal.all()).session(view.id);
      assert.equal(replay?.state, 'committed');
      assert.equal(replay?.items.find((item) => item.id === reply.id)?.statement, answer);
    } finally {
      test.journal.close();
    }
  });
  it('retains a whole-scene question/source without inventing a reference relation', async () => {
    const test = setup();
    try {
      const request = startRequest('What could I describe about this whole scene?');
      const view = await test.boopy.start({
        ...request,
        frame: { ...request.frame, source: 'past-recollection', timestampTrusted: false },
        attention: AttentionInput.parse({
          source: 'past-recollection',
          scope: 'scene',
          evidence: 'visual',
        }),
      });
      const reply = view.items.find((item) => item.id.endsWith('.__reply'));
      assert.ok(reply);
      assert.equal(view.referentId, null);
      assert.equal(
        view.relations.some((relation) => relation.from === reply.id && relation.kind === 'about'),
        false,
      );
      assert.equal(view.dialogue?.text, answer);
      assert.equal(test.inputs[0]?.scope, 'scene');
      assert.equal(test.inputs[0]?.sourceContext?.source, 'past-recollection');
      assert.equal(test.inputs[0]?.sourceContext?.timestampTrusted, false);
      assert.equal(test.inputs[0]?.said, 'What could I describe about this whole scene?');
      assert.equal(reply.status, 'proposed');
    } finally {
      test.journal.close();
    }
  });
  it('uses truthful no-answer fallback instead of a proposal-count receipt', async () => {
    const test = setup(null);
    try {
      const view = await test.boopy.start({ ...startRequest('Help me describe this'), requestId });
      assert.equal(
        view.dialogue?.text,
        "I couldn't tell what you meant from this view. Point at one thing and ask again.",
      );
      assert.equal(
        view.items.some((item) => item.id.endsWith('.__reply')),
        false,
      );
    } finally {
      test.journal.close();
    }
  });
  it('requires a bounded grounded first response without inventory quota or second tutor', () => {
    assert.match(SYSTEM_PROMPT, /first turn as well as follow-up/);
    assert.match(SYSTEM_PROMPT, /two short sentences/);
    assert.match(SYSTEM_PROMPT, /800 characters/);
    assert.match(SYSTEM_PROMPT, /one useful clarification/);
    assert.match(
      SYSTEM_PROMPT,
      /chosen downstream assistant \(Grok or Muse\) owns longer teaching and planning/,
    );
    assert.match(SYSTEM_PROMPT, /no inventory quota/);
    assert.doesNotMatch(
      SYSTEM_PROMPT,
      /Normally propose 3 to 10|With no selectedReference, response is null/,
    );
  });
});
