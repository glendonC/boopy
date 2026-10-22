import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { it } from 'node:test';
import { Boopy } from './boopy.ts';
import { SessionView } from './contracts.ts';
import { headsetApp } from './http/headset.ts';
import { FixtureInterpreter } from './interpret/fixture.ts';
import type { InterpretInput } from './interpret/interpreter.ts';
import { frameOf, startRequest, testBoopy } from './testing.ts';

const visual = {
  source: 'current-surroundings',
  scope: 'scene',
  evidence: 'visual',
  ocrRequested: true,
  segmentationRequested: true,
};

async function setup() {
  const calls = { interpretation: 0, ocr: 0, segmentation: 0 };
  const inputs: InterpretInput[] = [];
  const fixture = new FixtureInterpreter();
  const test = testBoopy({
    interpreter: {
      provider: 'fixture',
      model: 'synthetic-followup',
      async interpret(input) {
        calls.interpretation++;
        inputs.push(input);
        return fixture.interpret(input);
      },
    },
    segmenter: {
      provider: 'meta',
      model: 'sam-3.1', // Schema-compatible test double; never contacts a provider.
      async segment() {
        calls.segmentation++;
        return { outcome: 'no-match', latencyMs: 0, confidence: null };
      },
    },
  });
  test.text.read = async () => {
    calls.ocr++;
    return [];
  };
  const app = headsetApp(test.boopy, { logger: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  async function post(path: string, body: unknown) {
    const response = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 200);
    return SessionView.parse(await response.json());
  }
  return {
    ...test,
    calls,
    inputs,
    post,
    close: async () => {
      await app.close();
      test.journal.close();
    },
  };
}

it('an actual later supplied view resolves fresh-view without replaying the old utterance or changing original provenance', async () => {
  const test = await setup();
  try {
    const originalWords = 'Inspect this synthetic trip display.';
    const originalFrame = { ...frameOf(), source: 'current-surroundings', timestampTrusted: false };
    const initial = await test.post('/v1/sessions', {
      ...startRequest(originalWords),
      frame: originalFrame,
      attention: visual,
    });
    const originalObservation = initial.observations[0];
    const originalUtterance = initial.utterances[0];
    assert.ok(originalObservation && originalUtterance);
    const recordedOriginal = test.journal
      .all()
      .find((event) => event.type === 'observation.recorded');
    assert.ok(recordedOriginal);
    const before = { ...test.calls };
    const requestWords = 'Inspect the current synthetic display again.';
    const waiting = await test.post(`/v1/sessions/${initial.id}/utterances`, {
      speech: { text: requestWords },
      attention: visual,
    });
    assert.equal(waiting.attention?.action, 'fresh-view');
    assert.equal(waiting.attention?.observationId, null);
    assert.equal(waiting.observations.length, 1);
    assert.equal(waiting.utterances.at(-1)?.text, requestWords);
    assert.deepEqual(test.calls, before);
    const actualWords = 'This newly shown synthetic note is what I want to inspect.';
    const fresh = await test.post(`/v1/sessions/${initial.id}/utterances`, {
      speech: { text: actualWords },
      frame: {
        ...frameOf('korean-notes.jpg'),
        source: 'current-surroundings',
        timestampTrusted: false,
        capturedAt: '1970-01-01T18:00:10.000Z',
      },
      attention: visual,
    });
    assert.equal(fresh.attention?.action, 'reuse');
    assert.equal(fresh.observations.length, 2);
    assert.equal(fresh.attention?.observationId, fresh.observations[1]?.id);
    assert.notEqual(fresh.observations[1]?.id, originalObservation.id);
    assert.deepEqual(fresh.observations[0], originalObservation);
    assert.deepEqual(fresh.utterances[0], originalUtterance);
    assert.equal(fresh.utterances.at(-1)?.text, actualWords);
    assert.equal(fresh.utterances.length, 3);
    assert.deepEqual(
      test.inputs.map((input) => input.said),
      [originalWords, actualWords],
    );
    assert.equal(test.calls.interpretation, before.interpretation + 1);
    assert.equal(test.calls.ocr, before.ocr + 1);
    assert.deepEqual(
      test.journal.all().find((event) => event.id === recordedOriginal.id),
      recordedOriginal,
    );
    const observations = test.journal
      .all()
      .filter((event) => event.type === 'observation.recorded');
    assert.ok(
      observations[0]?.type === 'observation.recorded' &&
        observations[1]?.type === 'observation.recorded',
    );
    assert.notEqual(observations[0].data.frameSha256, observations[1].data.frameSha256);
    assert.deepEqual(new Boopy(test.deps).view(initial.id).attention, fresh.attention);
  } finally {
    await test.close();
  }
});

it('the alternative actual spoken turn after fresh-view retains its new words with no visual work', async () => {
  const test = await setup();
  try {
    const initial = await test.post('/v1/sessions', {
      ...startRequest('Inspect this synthetic display.'),
      frame: { ...frameOf(), source: 'current-surroundings', timestampTrusted: false },
      attention: visual,
    });
    const waiting = await test.post(`/v1/sessions/${initial.id}/utterances`, {
      speech: { text: 'Inspect this synthetic display again.' },
      attention: visual,
    });
    assert.equal(waiting.attention?.action, 'fresh-view');
    const before = { ...test.calls };
    const said = '그 기억은 더 추웠어요. This is my exact synthetic recollection.';
    const spoken = await test.post(`/v1/sessions/${initial.id}/utterances`, {
      speech: { text: said },
      attention: { ...visual, source: 'unknown', evidence: 'none' },
    });
    assert.equal(spoken.attention?.action, 'no-visual-work');
    assert.equal(spoken.attention?.observationId, null);
    assert.deepEqual(spoken.attention?.work, { ocr: false, segmentation: false });
    assert.equal(spoken.observations.length, 1);
    assert.deepEqual(spoken.observations[0], initial.observations[0]);
    assert.equal(spoken.utterances.at(-1)?.text, said);
    assert.deepEqual(test.calls, before);
    const authored = spoken.items.find(
      (item) => item.origin === 'person' && item.kind === 'utterance',
    );
    assert.equal(authored?.statement, said);
    assert.equal(authored?.confidence, null);
    const latest = test.journal
      .all()
      .filter((event) => event.type === 'utterance.heard')
      .at(-1);
    assert.ok(latest?.type === 'utterance.heard');
    assert.equal(latest.data.observationId, null);
    assert.equal(latest.data.text, said);
    assert.equal(latest.data.evidenceSource, 'unknown');
  } finally {
    await test.close();
  }
});
