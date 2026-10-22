import assert from 'node:assert/strict';
import { it } from 'node:test';
import { Boopy } from './boopy.ts';
import { ContextPackage, SessionView } from './contracts.ts';
import { evidenceRecords } from './evidence-contract.ts';
import { connectorApp } from './http/connector.ts';
import { headsetApp } from './http/headset.ts';
import { startRequest, testBoopy } from './testing.ts';

it('spoken-only authored evidence survives exclusion/reset and exports exact words without a model or frame', async () => {
  let perceptionCalls = 0;
  const { boopy, journal, deps } = testBoopy({
    interpreter: {
      provider: 'synthetic-not-called',
      model: 'synthetic-not-called',
      async interpret() {
        perceptionCalls++;
        throw new Error('Unexpected synthetic perception.');
      },
    },
  });
  const app = headsetApp(boopy, { logger: false });
  const connector = connectorApp(boopy, {
    token: 'synthetic-spoken-token',
    baseUrl: 'http://127.0.0.1',
    logger: false,
  });
  const said = '그 기억은 예상보다 추웠어요. I felt Much Colder on that Trip.';
  try {
    const started = await app.inject({
      method: 'POST',
      url: '/v1/sessions',
      payload: {
        cues: {},
        speech: { text: said },
        attention: { source: 'unknown', scope: 'scene', evidence: 'none' },
      },
    });
    assert.equal(started.statusCode, 200);
    let view = SessionView.parse(started.json());
    assert.equal(view.model, null);
    assert.equal(view.observations.length, 0);
    assert.equal(view.utterances[0]?.text, said);
    assert.equal(view.attention?.action, 'no-visual-work');
    const authored = view.items.find((item) => item.origin === 'person');
    assert.ok(authored);
    assert.equal(authored.kind, 'utterance');
    assert.equal(authored.status, 'confirmed');
    assert.equal(authored.confidence, null);
    assert.equal(authored.statement, said);
    for (const action of ['ignore', 'reset']) {
      const result: { statusCode: number; json(): unknown } = await app.inject({
        method: 'POST',
        url: `/v1/sessions/${view.id}/actions`,
        payload: { itemId: authored.id, action },
      });
      assert.equal(result.statusCode, 200);
      view = SessionView.parse(result.json());
      assert.equal(view.attention, undefined);
      assert.equal(view.dialogue, undefined);
      assert.equal(
        view.items.find((item) => item.id === authored.id)?.status,
        action === 'ignore' ? 'ignored' : 'confirmed',
      );
    }
    const renamed = await app.inject({
      method: 'POST',
      url: `/v1/sessions/${view.id}/utterances`,
      payload: {
        speech: { text: 'Rename this to synthetic cold memory' },
        cues: { targetItemId: authored.id },
      },
    });
    assert.equal(renamed.statusCode, 200);
    view = SessionView.parse(renamed.json());
    const relabelled = view.items.find((item) => item.id === authored.id);
    assert.equal(relabelled?.label, 'synthetic cold memory');
    assert.equal(relabelled?.statement, said);
    assert.equal(relabelled?.proposedLabel, undefined);
    assert.equal(relabelled?.origin, 'person');
    assert.equal(relabelled?.confidence, null);
    assert.equal(view.model, null);
    const saved = await app.inject({ method: 'POST', url: `/v1/sessions/${view.id}/commit` });
    assert.equal(saved.statusCode, 200);
    const id = SessionView.parse(saved.json()).committed?.packageId;
    assert.ok(id);
    const exported = await connector.inject({
      method: 'GET',
      url: `/v1/context/${id}`,
      headers: { authorization: 'Bearer synthetic-spoken-token' },
    });
    assert.equal(exported.statusCode, 200);
    const pkg = ContextPackage.parse(exported.json());
    assert.equal(pkg.provenance.models.length, 0);
    assert.equal(pkg.provenance.observations.length, 0);
    assert.equal(pkg.provenance.utterances[0]?.text, said);
    assert.equal(pkg.items[0]?.verification, 'authored');
    assert.equal(pkg.items[0]?.statement, said);
    assert.equal(pkg.items[0]?.label, 'synthetic cold memory');
    assert.equal(pkg.items[0]?.proposedLabel, undefined);
    assert.equal(pkg.items[0]?.confidence, null);
    const record = evidenceRecords(pkg).find((item) => item.itemId === authored.id);
    assert.ok(record);
    assert.equal(record.origin, 'person');
    assert.equal(record.kind, 'utterance');
    assert.equal(record.verification, 'authored');
    assert.equal(record.model, null);
    assert.equal(record.modelConfidence, null);
    assert.equal(record.observationId, null);
    assert.equal(record.statement, said);
    assert.equal(record.label, 'synthetic cold memory');
    assert.ok(record.humanActions.some((action) => action.op === 'relabel'));
    assert.deepEqual(new Boopy(deps).package(pkg.id), pkg);
    assert.equal(perceptionCalls, 0);
  } finally {
    await app.close();
    await connector.close();
    journal.close();
  }
});

it('a note added after failed interpretation is not the completed spoken-only utterance contract', async () => {
  const { boopy, journal } = testBoopy({
    interpreter: {
      provider: 'synthetic-failing',
      model: 'synthetic-failing',
      async interpret() {
        throw new Error('Synthetic interpretation failure.');
      },
    },
  });
  try {
    const view = await boopy.start(startRequest('Describe this synthetic view.'));
    assert.equal(view.model, null);
    const later = await boopy.utter(view.id, { speech: { text: 'Also add this synthetic note' } });
    const note = later.items.find((item) => item.origin === 'person');
    assert.ok(note);
    assert.equal(note.kind, 'note');
    assert.equal(note.status, 'confirmed');
    assert.ok(!later.items.some((item) => item.kind === 'utterance' && item.origin === 'person'));
    assert.notEqual(later.attention?.action, 'no-visual-work');
  } finally {
    journal.close();
  }
});
