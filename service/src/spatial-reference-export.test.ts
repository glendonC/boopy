import assert from 'node:assert/strict';
import { it } from 'node:test';
import { Boopy } from './boopy.ts';
import { ContextPackage, SessionView } from './contracts.ts';
import { evidenceRecords } from './evidence-contract.ts';
import { connectorApp } from './http/connector.ts';
import { headsetApp } from './http/headset.ts';
import { FixtureInterpreter } from './interpret/fixture.ts';
import { frameOf, startRequest, testBoopy } from './testing.ts';

async function setup() {
  let interpretations = 0;
  const fixture = new FixtureInterpreter();
  const test = testBoopy({
    interpreter: {
      provider: 'fixture',
      model: 'synthetic-two-object-reference',
      async interpret(input) {
        interpretations++;
        const result = await fixture.interpret(input);
        result.output.items = result.output.items.filter((item) =>
          ['photo', 'camels'].includes(item.key),
        );
        result.output.relations = result.output.relations.filter(
          (relation) => relation.from === 'camels' && relation.to === 'photo',
        );
        return result;
      },
    },
  });
  const app = headsetApp(test.boopy, { logger: false });
  const connector = connectorApp(test.boopy, {
    token: 'synthetic-reference-token',
    baseUrl: 'http://127.0.0.1',
    logger: false,
  });
  async function post(path: string, payload: unknown) {
    const response = await app.inject({
      method: 'POST',
      url: path,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(payload),
    });
    assert.equal(response.statusCode, 200);
    return SessionView.parse(response.json());
  }
  return {
    ...test,
    post,
    connector,
    count: () => interpretations,
    close: async () => {
      await app.close();
      await connector.close();
      test.journal.close();
    },
  };
}

it('a fresh-turn personal note preserves its target original source and exact words without confirming refocus', async () => {
  const test = await setup();
  try {
    const initial = await test.post(
      '/v1/sessions',
      startRequest('Inspect this synthetic two-object display.'),
    );
    const photo = initial.items.find((item) => item.label === 'Desert photo');
    const other = initial.items.find((item) => item.label === 'Camels');
    assert.ok(photo && other);
    assert.equal(initial.referentId, photo.id);
    const originalSource = other.grounding.observationId;
    assert.ok(originalSource);
    const originalGrounding = structuredClone(other.grounding);
    const words = 'I remember this synthetic object from last year. 그 기억은 작년 것이에요.';
    const noted = await test.post(`/v1/sessions/${initial.id}/utterances`, {
      speech: { text: words },
      cues: { targetItemId: other.id },
      frame: {
        ...frameOf('korean-notes.jpg'),
        source: 'current-surroundings',
        timestampTrusted: false,
      },
      attention: { source: 'current-surroundings', scope: 'target', evidence: 'visual' },
    });
    assert.equal(noted.observations.length, 2);
    const currentSource = noted.observations[1]?.id;
    assert.ok(currentSource && currentSource !== originalSource);
    const noteUtterance = noted.utterances.at(-1);
    assert.ok(noteUtterance);
    assert.equal(noteUtterance.text, words);
    assert.equal(noted.items.find((item) => item.id === other.id)?.note, words);
    const focused = await test.post(`/v1/sessions/${initial.id}/utterances`, {
      speech: { text: 'I mean this one' },
      cues: { targetItemId: other.id },
    });
    assert.equal(focused.referentId, other.id);
    assert.equal(test.count(), 1);
    const selected = focused.items.find((item) => item.id === other.id);
    assert.equal(selected?.status, 'proposed');
    assert.equal(selected?.confidence, other.confidence);
    assert.deepEqual(selected?.grounding, originalGrounding);
    const focusUtterance = focused.utterances.at(-1);
    const focusEvent = test.journal.all().find((event) => event.type === 'interaction.focused');
    assert.ok(focusEvent?.type === 'interaction.focused');
    assert.equal(focusEvent.actor, 'person');
    assert.equal(focusEvent.data.itemId, other.id);
    assert.equal(focusEvent.data.utteranceId, focusUtterance?.id);
    const saved = await test.post(`/v1/sessions/${initial.id}/commit`, {});
    const id = saved.committed?.packageId;
    assert.ok(id);
    const fetched = await test.connector.inject({
      method: 'GET',
      url: `/v1/context/${id}`,
      headers: { authorization: 'Bearer synthetic-reference-token' },
    });
    assert.equal(fetched.statusCode, 200);
    const pkg = ContextPackage.parse(fetched.json());
    const exportedNote = pkg.provenance.utterances.find(
      (utterance) => utterance.id === noteUtterance.id,
    );
    assert.equal(exportedNote?.text, words);
    assert.equal(exportedNote?.targetItemId, other.id);
    assert.equal(exportedNote?.targetObservationId, originalSource);
    assert.equal(exportedNote?.observationId, currentSource);
    const record = evidenceRecords(pkg).find((entry) => entry.itemId === other.id);
    assert.equal(record?.note, words);
    assert.equal(record?.observationId, originalSource);
    assert.equal(record?.verification, 'accepted');
    assert.equal(record?.modelConfidence, other.confidence);
    assert.ok(pkg.text.includes(words));
    assert.ok(pkg.text.includes(other.id));
    assert.ok(pkg.text.includes(originalSource));
    assert.ok(pkg.text.includes(currentSource));
    const replay = new Boopy(test.deps);
    assert.equal(replay.view(initial.id).referentId, other.id);
    assert.deepEqual(replay.package(pkg.id), pkg);
  } finally {
    await test.close();
  }
});

it('ignored target references preserve recorded words without resurrecting excluded identity or evidence', async () => {
  const test = await setup();
  try {
    const initial = await test.post(
      '/v1/sessions',
      startRequest('Inspect this synthetic display.'),
    );
    const target = initial.items.find((item) => item.label === 'Camels');
    assert.ok(target);
    const words = 'This synthetic detail is from last year.';
    const noted = await test.post(`/v1/sessions/${initial.id}/utterances`, {
      speech: { text: words },
      cues: { targetItemId: target.id },
    });
    const utteranceId = noted.utterances.at(-1)?.id;
    await test.post(`/v1/sessions/${initial.id}/actions`, { itemId: target.id, action: 'ignore' });
    const saved = await test.post(`/v1/sessions/${initial.id}/commit`, {});
    const pkg = test.boopy.package(saved.committed?.packageId ?? '');
    assert.ok(pkg);
    const exported = pkg.provenance.utterances.find((utterance) => utterance.id === utteranceId);
    assert.equal(exported?.text, words);
    assert.equal(exported?.targetItemId, null);
    assert.equal(exported?.targetObservationId, null);
    assert.ok(!pkg.items.some((item) => item.id === target.id));
    assert.ok(!evidenceRecords(pkg).some((item) => item.itemId === target.id));
    assert.ok(!pkg.text.includes(target.id));
    assert.equal(test.count(), 1);
  } finally {
    await test.close();
  }
});

it('historical known and rejected references retain source identity with explicit disposition', async () => {
  for (const action of ['known', 'reject']) {
    const test = await setup();
    try {
      const initial = await test.post(
        '/v1/sessions',
        startRequest('Inspect this synthetic display.'),
      );
      const target = initial.items.find((item) => item.label === 'Camels');
      assert.ok(target);
      const words = 'My synthetic recollection belongs to this object.';
      const noted = await test.post(`/v1/sessions/${initial.id}/utterances`, {
        speech: { text: words },
        cues: { targetItemId: target.id },
      });
      const utteranceId = noted.utterances.at(-1)?.id;
      await test.post(`/v1/sessions/${initial.id}/actions`, { itemId: target.id, action });
      const saved = await test.post(`/v1/sessions/${initial.id}/commit`, {});
      const pkg = test.boopy.package(saved.committed?.packageId ?? '');
      assert.ok(pkg);
      const record = evidenceRecords(pkg).find((item) => item.itemId === target.id);
      const disposition = action === 'known' ? 'known' : 'rejected';
      assert.equal(record?.disposition, disposition);
      assert.equal(record?.verification, 'unconfirmed');
      assert.ok(!pkg.items.some((item) => item.id === target.id));
      const exported = pkg.provenance.utterances.find((utterance) => utterance.id === utteranceId);
      assert.equal(exported?.targetItemId, target.id);
      assert.equal(exported?.targetObservationId, target.grounding.observationId);
      assert.ok(pkg.text.includes(`${disposition}; unconfirmed`));
      assert.ok(pkg.text.includes('selecting an item does not confirm its interpretation'));
      assert.equal(test.count(), 1);
    } finally {
      await test.close();
    }
  }
});
