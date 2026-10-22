import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Boopy } from './boopy.ts';
import { ContextPackage } from './contracts.ts';
import { evidenceRecords, evidenceSourceId } from './evidence-contract.ts';
import { headsetApp } from './http/headset.ts';
import { startRequest, testBoopy } from './testing.ts';

const commit = async (boopy: Boopy) => {
  const view = await boopy.start(startRequest('Describe this trip.'));
  const saved = boopy.commit(view.id);
  const pkg = boopy.package(saved.committed?.packageId ?? '');
  assert.ok(pkg);
  return pkg;
};

describe('versioned evidence and explicit corrections', () => {
  it('retains source links and exact human events across known, rejected, questions and additions', async () => {
    const { boopy, journal, deps, text } = testBoopy();
    const written = '사 막!?  그대로';
    text.lines = [
      { text: written, confidence: 0.81, box: { x0: 0.44, y0: 0.54, x1: 0.46, y1: 0.56 } },
    ];
    const view = await boopy.start(startRequest('Describe this trip.'));
    const known = view.items.find((item) => item.label === 'desert');
    const rejected = view.items.find((item) => item.label === 'Tents');
    assert.ok(known && rejected);
    boopy.act(view.id, { itemId: known.id, action: 'known' });
    await boopy.utter(view.id, {
      speech: { text: "Not that, we didn't camp" },
      cues: { targetItemId: rejected.id },
    });
    await boopy.utter(view.id, { speech: { text: 'I also want to talk about the sunset' } });
    const saved = boopy.commit(view.id);
    const pkg = ContextPackage.parse(boopy.package(saved.committed?.packageId ?? ''));
    assert.equal(pkg.version, 2);
    const records = evidenceRecords(pkg);
    assert.ok(records.some((record) => record.text.includes(written)));
    for (const disposition of ['known', 'rejected', 'question', 'intent']) {
      const record = records.find((entry) => entry.disposition === disposition);
      assert.ok(record);
      assert.equal(record.observationId, view.observations[0]?.id);
      assert.equal(record.utteranceId, view.utterances[0]?.id);
      assert.equal(record.model?.provider, 'fixture');
      assert.ok(record.interpretationId);
    }
    const knownRecord = records.find((entry) => entry.itemId === known.id);
    assert.equal(knownRecord?.humanActions[0]?.op, 'known');
    const rejection = records.find((entry) => entry.itemId === rejected.id);
    const action = rejection?.humanActions[0];
    assert.ok(action?.utteranceId);
    assert.equal(journal.all().find((event) => event.id === action.eventId)?.actor, 'person');
    const added = records.find((entry) => entry.origin === 'person');
    assert.equal(added?.modelConfidence, null);
    assert.equal(added?.model, null);
    assert.equal(added?.verification, 'authored');
    assert.ok(added?.utteranceId);
    assert.deepEqual(new Boopy(deps).package(pkg.id), pkg);
    journal.close();
  });

  it('reads old packages but refuses to infer missing evidence or support unknown versions', async () => {
    const { boopy, journal } = testBoopy();
    const pkg = await commit(boopy);
    const legacy = { ...pkg, version: 1, evidence: undefined };
    assert.equal(ContextPackage.parse(legacy).version, 1);
    assert.throws(() => evidenceRecords(legacy));
    assert.throws(() => ContextPackage.parse({ ...pkg, version: 99 }));
    assert.throws(() => evidenceRecords({ ...pkg, evidence: { version: 99, records: [] } }));
    const records = evidenceRecords(pkg);
    assert.throws(() =>
      evidenceRecords({ ...pkg, evidence: { version: 1, records: [...records, records[0]] } }),
    );
    journal.close();
  });

  it('journals exact targets idempotently, rejects stale/conflicting links and replays without rewriting snapshots', async () => {
    const { boopy, journal, deps } = testBoopy();
    const a = await commit(boopy);
    const b = await commit(boopy);
    const c = await commit(boopy);
    const ref = (pkg: typeof a) => {
      const record = evidenceRecords(pkg)[0];
      assert.ok(record);
      return { packageId: pkg.id, itemId: record.itemId };
    };
    const before = JSON.stringify(a);
    const request = { predecessor: ref(a), successor: ref(b) };
    const link = boopy.supersede(request);
    assert.deepEqual(boopy.supersede(request), link);
    assert.equal(journal.all().filter((event) => event.type === 'evidence.superseded').length, 1);
    assert.throws(() => boopy.supersede({ predecessor: ref(a), successor: ref(c) }));
    assert.throws(() => boopy.supersede({ predecessor: ref(b), successor: ref(a) }));
    assert.throws(() => boopy.supersede({ predecessor: ref(b), successor: ref(b) }));
    assert.throws(() =>
      boopy.supersede({ predecessor: ref(c), successor: { ...ref(b), itemId: 'missing' } }),
    );
    boopy.supersede({ predecessor: ref(b), successor: ref(c) });
    assert.equal(JSON.stringify(boopy.package(a.id)), before);
    assert.deepEqual(new Boopy(deps).supersessions, boopy.supersessions);
    assert.equal(evidenceRecords(b)[0]?.verification, 'accepted');
    assert.notEqual(evidenceSourceId(ref(a)), evidenceSourceId(ref(b)));
    journal.close();
  });

  it('exposes correction linking only through the loopback write API with validated bodies', async () => {
    const { boopy, journal } = testBoopy();
    const app = headsetApp(boopy, { logger: false });
    try {
      const invalid = await app.inject({
        method: 'POST',
        url: '/v1/evidence/supersede',
        payload: {},
      });
      assert.equal(invalid.statusCode, 400);
      const remote = await app.inject({
        method: 'POST',
        url: '/v1/evidence/supersede',
        headers: { host: 'evil.example' },
        payload: {},
      });
      assert.equal(remote.statusCode, 403);
    } finally {
      await app.close();
      journal.close();
    }
  });
});
