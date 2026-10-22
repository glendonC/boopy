import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Boopy, BoopyError } from './boopy.ts';
import { evidenceRecords } from './evidence-contract.ts';
import { FixtureInterpreter } from './interpret/fixture.ts';
import { frameOf, startRequest, testBoopy } from './testing.ts';

function setup() {
  const calls = { interpretation: 0, ocr: 0, segmentation: 0, speech: 0, media: 0 };
  const fixture = new FixtureInterpreter();
  const test = testBoopy({
    interpreter: {
      provider: 'fixture',
      model: 'synthetic-two-objects',
      async interpret(input) {
        calls.interpretation++;
        const result = await fixture.interpret(input);
        return {
          ...result,
          output: {
            ...result.output,
            items: result.output.items.slice(0, 2),
            relations: [],
            questions: [],
          },
        };
      },
    },
    segmenter: {
      provider: 'meta',
      model: 'sam-3.1',
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
  test.speech.transcribe = async () => {
    calls.speech++;
    return { text: 'This one.', language: 'en' };
  };
  const put = test.deps.media.put.bind(test.deps.media);
  test.deps.media.put = (bytes, extension) => {
    calls.media++;
    return put(bytes, extension);
  };
  return {
    ...test,
    calls,
    reset: () => {
      for (const key of Object.keys(calls) as (keyof typeof calls)[]) calls[key] = 0;
    },
  };
}
const zero = { interpretation: 0, ocr: 0, segmentation: 0, speech: 0, media: 0 };

describe('explicit spatial reference selects existing evidence', () => {
  it('this-one focuses the exact live item without perception, confirmation, emphasis or source replacement', async () => {
    const { boopy, deps, journal, calls, reset } = setup();
    try {
      const first = await boopy.start(startRequest('Synthetic view with two objects.'));
      const objects = first.items.filter((item) => item.kind === 'object');
      assert.equal(objects.length, 2);
      const target = objects[1];
      assert.ok(target);
      const before = structuredClone(first.items);
      const corrections = journal.all().filter((event) => event.type === 'item.corrected').length;
      reset();
      const focused = await boopy.utter(first.id, {
        speech: { text: 'This one.' },
        cues: { targetItemId: target.id },
      });
      assert.equal(focused.referentId, target.id);
      assert.deepEqual(focused.items, before);
      assert.deepEqual(calls, zero);
      assert.equal(
        journal.all().filter((event) => event.type === 'item.corrected').length,
        corrections,
      );
      const event = journal.all().find((record) => record.type === 'interaction.focused');
      assert.ok(event?.type === 'interaction.focused');
      assert.equal(event.actor, 'person');
      assert.equal(event.data.itemId, target.id);
      assert.equal(event.data.utteranceId, focused.utterances.at(-1)?.id);
      assert.equal(focused.notice, `Now talking about "${target.label}".`);
      assert.equal(focused.dialogue?.utteranceId, focused.utterances.at(-1)?.id);
      const replay = new Boopy(deps).view(first.id);
      assert.equal(replay.referentId, target.id);
      assert.deepEqual(replay.items, before);
      assert.equal(replay.notice, focused.notice);
      const saved = boopy.commit(first.id);
      const pkg = boopy.package(saved.committed?.packageId ?? '');
      assert.ok(pkg);
      const evidence = evidenceRecords(pkg).find((record) => record.itemId === target.id);
      assert.ok(evidence);
      assert.equal(evidence.verification, 'accepted');
      assert.equal(evidence.modelConfidence, target.confidence);
      assert.equal(evidence.humanActions.length, 0);
      assert.equal(pkg.provenance.utterances.at(-1)?.targetItemId, target.id);
      assert.equal(
        pkg.provenance.utterances.at(-1)?.targetObservationId,
        target.grounding.observationId,
      );
    } finally {
      journal.close();
    }
  });

  it('no-new-frame target speech uses original item source rather than newer unrelated observation', async () => {
    const { boopy, journal, calls, reset } = setup();
    try {
      const first = await boopy.start(startRequest('Synthetic old view.'));
      const target = first.items.find((item) => item.kind === 'object');
      assert.ok(target?.grounding.observationId);
      const originalObservation = target.grounding.observationId;
      const newer = await boopy.utter(first.id, {
        frame: frameOf('korean-notes.jpg'),
        speech: { text: 'Synthetic unrelated view context.' },
        attention: {
          source: 'unknown',
          scope: 'scene',
          evidence: 'none',
          ambiguousTarget: false,
          ocrRequested: false,
          segmentationRequested: false,
          maxAgeMs: 15000,
        },
      });
      const newerObservation = newer.observations.at(-1)?.id;
      assert.notEqual(newerObservation, originalObservation);
      reset();
      await boopy.utter(first.id, {
        cues: { targetItemId: target.id },
        speech: { text: 'I mean this one.' },
        attention: {
          source: 'current-surroundings',
          scope: 'target',
          evidence: 'visual',
          observationId: newerObservation,
          ambiguousTarget: false,
          ocrRequested: true,
          segmentationRequested: true,
          maxAgeMs: 15000,
        },
      });
      const heard = journal
        .all()
        .filter((event) => event.type === 'utterance.heard')
        .at(-1);
      assert.ok(heard?.type === 'utterance.heard');
      assert.equal(heard.data.targetItemId, target.id);
      assert.equal(heard.data.observationId, originalObservation);
      assert.deepEqual(calls, zero);
    } finally {
      journal.close();
    }
  });

  it('a supplied new frame is distinct from existing target evidence and still does not rerun perception', async () => {
    const { boopy, journal, calls, reset } = setup();
    try {
      const first = await boopy.start(startRequest('Synthetic initial view.'));
      const target = first.items.find((item) => item.kind === 'object');
      assert.ok(target?.grounding.observationId);
      reset();
      const focused = await boopy.utter(first.id, {
        frame: frameOf('korean-notes.jpg'),
        speech: { text: 'This one.' },
        cues: { targetItemId: target.id },
      });
      assert.deepEqual(calls, { ...zero, media: 1 });
      assert.equal(focused.referentId, target.id);
      assert.equal(
        focused.items.find((item) => item.id === target.id)?.grounding.observationId,
        target.grounding.observationId,
      );
      const heard = journal
        .all()
        .filter((event) => event.type === 'utterance.heard')
        .at(-1);
      assert.ok(heard?.type === 'utterance.heard');
      assert.equal(heard.data.observationId, focused.observations.at(-1)?.id);
      assert.notEqual(heard.data.observationId, target.grounding.observationId);
    } finally {
      journal.close();
    }
  });

  it('later unrelated interpretation keeps explicitly selected proposal identity and original source', async () => {
    const { boopy, deps, journal } = setup();
    try {
      const first = await boopy.start(startRequest('Synthetic first view.'));
      const target = first.items.find((item) => item.label === 'Camels');
      assert.ok(target);
      const original = structuredClone(target);
      await boopy.utter(first.id, {
        speech: { text: 'This one.' },
        cues: { targetItemId: target.id },
      });
      const later = await boopy.utter(first.id, {
        frame: frameOf('korean-notes.jpg'),
        speech: { text: 'Describe this unrelated new view.' },
      });
      assert.deepEqual(
        later.items.find((item) => item.id === target.id),
        original,
      );
      assert.notEqual(later.observations.at(-1)?.id, original.grounding.observationId);
      assert.equal(original.status, 'proposed');
      assert.equal(original.emphasis, false);
      assert.deepEqual(
        new Boopy(deps).view(first.id).items.find((item) => item.id === target.id),
        original,
      );
      const saved = boopy.commit(first.id);
      const pkg = boopy.package(saved.committed?.packageId ?? '');
      assert.ok(pkg);
      const record = evidenceRecords(pkg).find((item) => item.itemId === target.id);
      assert.ok(record);
      assert.equal(record.observationId, original.grounding.observationId);
      assert.equal(record.verification, 'accepted');
      assert.equal(record.modelConfidence, original.confidence);
      assert.equal(record.humanActions.length, 0);
    } finally {
      journal.close();
    }
  });

  it('same label from a later observation never merges with refocus-only historical proposal', async () => {
    const { boopy, deps, journal } = setup();
    try {
      const first = await boopy.start(startRequest('Synthetic first camel view.'));
      const original = first.items.find((item) => item.label === 'Camels');
      assert.ok(original?.grounding.observationId);
      const originalSnapshot = structuredClone(original);
      await boopy.utter(first.id, {
        speech: { text: 'This one.' },
        cues: { targetItemId: original.id },
      });
      const later = await boopy.utter(first.id, {
        frame: frameOf('korean-notes.jpg'),
        speech: { text: 'Describe the separate synthetic observation.' },
      });
      const sameLabels = later.items.filter((item) => item.label === 'Camels');
      assert.equal(sameLabels.length, 2);
      const historical = sameLabels.find((item) => item.id === original.id);
      const newProposal = sameLabels.find((item) => item.id !== original.id);
      assert.deepEqual(historical, originalSnapshot);
      assert.ok(newProposal);
      assert.notEqual(newProposal.grounding.observationId, original.grounding.observationId);
      assert.equal(newProposal.grounding.observationId, later.observations.at(-1)?.id);
      assert.equal(newProposal.status, 'proposed');
      assert.equal(newProposal.emphasis, false);
      assert.equal(
        later.relations.some(
          (relation) =>
            relation.kind === 'same_as' &&
            ((relation.from === original.id && relation.to === newProposal.id) ||
              (relation.from === newProposal.id && relation.to === original.id)),
        ),
        false,
      );
      assert.equal(
        new Boopy(deps).view(first.id).items.filter((item) => item.label === 'Camels').length,
        2,
      );
      const saved = boopy.commit(first.id);
      const pkg = boopy.package(saved.committed?.packageId ?? '');
      assert.ok(pkg);
      const evidence = evidenceRecords(pkg).filter((item) => item.label === 'Camels');
      assert.equal(evidence.length, 2);
      assert.equal(new Set(evidence.map((item) => item.sourceId)).size, 2);
      assert.equal(new Set(evidence.map((item) => item.observationId)).size, 2);
      assert.equal(
        evidence.every(
          (item) => item.verification === 'accepted' && item.humanActions.length === 0,
        ),
        true,
      );
    } finally {
      journal.close();
    }
  });

  it('missing, foreign and excluded explicit targets fail before media, speech, perception or journal changes', async () => {
    const { boopy, journal, calls, reset } = setup();
    try {
      const first = await boopy.start(startRequest('Synthetic first session.'));
      const other = await boopy.start(startRequest('Synthetic foreign session.'));
      const targets = first.items.filter((item) => item.kind === 'object');
      const excluded = targets[0],
        ignored = targets[1];
      const foreign = other.items.find((item) => item.kind === 'object');
      assert.ok(excluded && ignored && foreign);
      boopy.act(first.id, { itemId: excluded.id, action: 'reject' });
      boopy.act(first.id, { itemId: ignored.id, action: 'ignore' });
      for (const [itemId, code, status] of [
        ['synthetic-missing', 'no_item', 404],
        [foreign.id, 'no_item', 404],
        [excluded.id, 'inactive_item', 409],
        [ignored.id, 'inactive_item', 409],
      ] as const) {
        reset();
        const count = journal.all().length;
        const before = structuredClone(boopy.view(first.id));
        await assert.rejects(
          boopy.utter(first.id, {
            frame: frameOf(),
            speech: { wav: Buffer.from('synthetic-clip').toString('base64') },
            cues: { targetItemId: itemId },
          }),
          (error) => error instanceof BoopyError && error.status === status && error.code === code,
        );
        assert.equal(journal.all().length, count);
        assert.deepEqual(calls, zero);
        assert.deepEqual(boopy.view(first.id), before);
      }
    } finally {
      journal.close();
    }
  });

  it('known evidence remains known and untargeted refocus keeps existing interpretation path', async () => {
    const { boopy, journal, calls, reset } = setup();
    try {
      const first = await boopy.start(startRequest('Synthetic view.'));
      const target = first.items.find((item) => item.kind === 'object');
      assert.ok(target);
      boopy.act(first.id, { itemId: target.id, action: 'known' });
      reset();
      const focused = await boopy.utter(first.id, {
        speech: { text: 'This one.' },
        cues: { targetItemId: target.id },
      });
      assert.equal(focused.items.find((item) => item.id === target.id)?.status, 'known');
      assert.deepEqual(calls, zero);
      reset();
      await boopy.utter(first.id, { speech: { text: 'I mean this one.' } });
      assert.equal(calls.interpretation, 1);
      assert.equal(calls.ocr, 1);
      assert.equal(journal.all().filter((event) => event.type === 'interaction.focused').length, 1);
    } finally {
      journal.close();
    }
  });
});
