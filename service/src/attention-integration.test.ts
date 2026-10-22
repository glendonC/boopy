import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Boopy } from './boopy.ts';
import { StartSessionRequest, type UtteranceRequest } from './contracts.ts';
import { evidenceRecords } from './evidence-contract.ts';
import { connectorApp } from './http/connector.ts';
import { FixtureInterpreter } from './interpret/fixture.ts';
import type { InterpretInput } from './interpret/interpreter.ts';
import type { Segmenter } from './segmentation.ts';
import { frameOf, startRequest, testBoopy } from './testing.ts';

function setup() {
  const calls = { interpretation: 0, ocr: 0, segmentation: 0 };
  const inputs: InterpretInput[] = [];
  const fixture = new FixtureInterpreter();
  const segmenter: Segmenter = {
    provider: 'meta',
    model: 'sam-3.1',
    async segment() {
      calls.segmentation++;
      return { outcome: 'no-match', latencyMs: 0, confidence: null };
    },
  };
  const test = testBoopy({
    interpreter: {
      provider: 'fixture',
      model: 'counted-synthetic',
      async interpret(input) {
        calls.interpretation++;
        inputs.push(input);
        return fixture.interpret(input);
      },
    },
    segmenter,
  });
  test.text.read = async () => {
    calls.ocr++;
    return [];
  };
  return {
    ...test,
    calls,
    inputs,
    reset: () => {
      calls.interpretation = 0;
      calls.ocr = 0;
      calls.segmentation = 0;
    },
  };
}
const policy: NonNullable<UtteranceRequest['attention']> = {
  scope: 'scene',
  evidence: 'visual',
  source: 'current-surroundings',
  ambiguousTarget: false,
  ocrRequested: false,
  segmentationRequested: false,
  maxAgeMs: 15000,
};
const zero = { interpretation: 0, ocr: 0, segmentation: 0 };

describe('journaled explicit-turn attention integration', () => {
  it('hands exact bilingual recollection to REST and MCP as person-authored evidence', async () => {
    const { boopy, deps, journal, calls } = setup();
    const app = connectorApp(boopy, {
      token: 'synthetic-token',
      baseUrl: 'http://127.0.0.1',
      logger: false,
    });
    const client = new Client({ name: 'synthetic-attention-handoff', version: '1' });
    try {
      const said = '그 여행은 예상보다 추웠어요. I felt Much Colder on that Trip.';
      const view = await boopy.start({
        cues: {},
        speech: { text: said },
        attention: { ...policy, source: 'past-recollection', evidence: 'none' },
      });
      const later = await boopy.utter(view.id, {
        speech: { text: 'Describe the current room without looking.' },
        attention: { ...policy, source: 'current-surroundings', evidence: 'none' },
      });
      assert.equal(later.attention?.source, 'current-surroundings');
      assert.equal(later.attention?.utteranceId, later.utterances.at(-1)?.id);
      const saved = boopy.commit(view.id);
      const pkg = boopy.package(saved.committed?.packageId ?? '');
      assert.ok(pkg);
      assert.ok(pkg.text.includes(said));
      const record = evidenceRecords(pkg).find((entry) => entry.kind === 'utterance');
      assert.ok(record);
      assert.equal(record.statement, said);
      assert.equal(record.origin, 'person');
      assert.equal(record.verification, 'authored');
      assert.equal(record.modelConfidence, null);
      assert.equal(record.model, null);
      assert.equal(record.observationId, null);
      assert.equal(record.sourceContext, 'past-recollection');
      assert.match(pkg.text, /Requested evidence context: past-recollection/);
      assert.match(pkg.text, /does not verify the depicted place or event time/);
      assert.equal(pkg.provenance.utterances[0]?.evidenceSource, 'past-recollection');
      assert.equal(pkg.provenance.utterances.at(-1)?.evidenceSource, 'current-surroundings');
      assert.equal(
        evidenceRecords(new Boopy(deps).package(pkg.id)).find(
          (entry) => entry.utteranceId === view.utterances[0]?.id,
        )?.sourceContext,
        'past-recollection',
      );
      assert.equal(record.utteranceId, view.utterances[0]?.id);
      assert.equal(pkg.provenance.utterances[0]?.source, 'typed');
      assert.deepEqual(new Boopy(deps).package(pkg.id), pkg);
      await app.listen({ host: '127.0.0.1', port: 0 });
      const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
      const rest = await fetch(`${base}/v1/context/${pkg.id}`, {
        headers: { authorization: 'Bearer synthetic-token' },
      });
      assert.equal(rest.status, 200);
      const restPackage = await rest.json();
      assert.equal(restPackage.items[0].statement, said);
      assert.equal(
        evidenceRecords(restPackage).find((entry) => entry.utteranceId === view.utterances[0]?.id)
          ?.sourceContext,
        'past-recollection',
      );
      assert.match(restPackage.text, /Requested evidence context: past-recollection/);
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
          requestInit: { headers: { authorization: 'Bearer synthetic-token' } },
        }),
      );
      const fetched = await client.callTool({ name: 'fetch', arguments: { id: pkg.id } });
      const block = fetched.content[0];
      assert.ok(block?.type === 'text');
      const document = JSON.parse(block.text);
      assert.equal(document.metadata.package.items[0].statement, said);
      assert.ok(document.text.includes(said));
      assert.equal(
        evidenceRecords(document.metadata.package).find(
          (entry) => entry.utteranceId === view.utterances[0]?.id,
        )?.sourceContext,
        'past-recollection',
      );
      assert.match(document.text, /Requested evidence context: past-recollection/);
      assert.deepEqual(calls, zero);
    } finally {
      await client.close();
      await app.close();
      journal.close();
    }
  });

  it('clears old dialogue and attention after a direct human action', async () => {
    const { boopy, deps, journal } = setup();
    try {
      const view = await boopy.start(startRequest('Describe this trip.'));
      const response = await boopy.utter(view.id, {
        speech: { text: 'Remember that I felt cold.' },
        attention: { ...policy, evidence: 'none' },
      });
      assert.ok(response.dialogue);
      assert.ok(response.attention);
      const target = response.items.find((item) => item.kind === 'object');
      assert.ok(target);
      const changed = boopy.act(view.id, { itemId: target.id, action: 'confirm' });
      assert.ok(changed.dialogue == null);
      assert.ok(changed.attention == null);
      assert.ok(new Boopy(deps).view(view.id).dialogue == null);
      assert.ok(new Boopy(deps).view(view.id).attention == null);
      const note = 'I felt Much Colder during that Trip.';
      const noted = await boopy.utter(view.id, {
        speech: { text: note },
        cues: { targetItemId: target.id },
        attention: { ...policy, evidence: 'none' },
      });
      assert.equal(noted.dialogue?.utteranceId, noted.utterances.at(-1)?.id);
      assert.deepEqual(new Boopy(deps).view(view.id).dialogue, noted.dialogue);
    } finally {
      journal.close();
    }
  });

  it('preserves explicit source on targeted note corrections without invoking attention work', async () => {
    const { boopy, deps, journal, calls, reset } = setup();
    try {
      const view = await boopy.start(startRequest('Describe this trip.'));
      const target = view.items.find((item) => item.kind === 'object');
      assert.ok(target);
      reset();
      const note = 'That photo was from a past trip; I felt much colder.';
      const corrected = await boopy.utter(view.id, {
        speech: { text: note },
        cues: { targetItemId: target.id },
        attention: { ...policy, source: 'past-recollection', evidence: 'none' },
      });
      assert.equal(corrected.items.find((item) => item.id === target.id)?.note, note);
      assert.deepEqual(calls, zero);
      const saved = boopy.commit(view.id);
      const pkg = boopy.package(saved.committed?.packageId ?? '');
      assert.ok(pkg);
      assert.equal(pkg.provenance.utterances.at(-1)?.evidenceSource, 'past-recollection');
      assert.deepEqual(new Boopy(deps).package(pkg.id), pkg);
      assert.equal(
        new Boopy(deps).package(pkg.id)?.provenance.utterances.at(-1)?.evidenceSource,
        'past-recollection',
      );
    } finally {
      journal.close();
    }
  });

  it('does not turn a silent transcription into authored context or a successful reply', async () => {
    const { boopy, journal, speech, calls } = setup();
    try {
      speech.heard = { text: '  ', language: 'en' };
      await assert.rejects(
        boopy.start({
          cues: {},
          speech: { wav: 'UklGRg==' },
          attention: { ...policy, evidence: 'none', source: 'past-recollection' },
        }),
        (error: unknown) => error instanceof Error && 'code' in error && error.code === 'no_words',
      );
      assert.equal(
        journal
          .all()
          .filter((event) =>
            ['utterance.heard', 'item.corrected', 'interaction.responded'].includes(event.type),
          ).length,
        0,
      );
      assert.deepEqual(calls, zero);
    } finally {
      journal.close();
    }
  });

  it('rejects malformed no-frame inputs before creating state', async () => {
    assert.throws(() => StartSessionRequest.parse({ cues: {}, speech: { text: 'Hi' } }));
    assert.throws(() =>
      StartSessionRequest.parse({
        cues: {},
        speech: { text: 'Hi' },
        attention: { ...policy, maxAgeMs: -1, evidence: 'none' },
      }),
    );
    assert.throws(() =>
      StartSessionRequest.parse({
        cues: {},
        speech: { text: '' },
        attention: { ...policy, evidence: 'none' },
      }),
    );
    const { boopy, journal } = setup();
    try {
      await assert.rejects(boopy.start({ cues: {}, speech: { text: 'Hi' } }), /frame is required/);
      assert.equal(journal.all().length, 0);
    } finally {
      journal.close();
    }
  });

  it('starts a no-visual turn without a frame and retains speech without perception', async () => {
    const { boopy, deps, journal, calls } = setup();
    try {
      const said = 'It felt Much Colder than expected.';
      const view = await boopy.start({
        cues: {},
        speech: { text: said },
        attention: { ...policy, evidence: 'none' },
      });
      assert.equal(view.attention?.action, 'no-visual-work');
      assert.equal(view.observations.length, 0);
      assert.equal(view.utterances.at(-1)?.text, said);
      assert.deepEqual(calls, zero);
      assert.deepEqual(new Boopy(deps).view(view.id).attention, view.attention);
    } finally {
      journal.close();
    }
  });

  it('keeps legacy capture compatible and skips perception for no-visual/clarify/fresh-view outcomes', async () => {
    const { boopy, deps, journal, calls, reset } = setup();
    try {
      const view = await boopy.start(startRequest('Describe this trip.'));
      assert.equal(calls.interpretation, 1);
      reset();
      const cases = [
        { attention: { ...policy, evidence: 'none' as const }, action: 'no-visual-work' },
        { attention: { ...policy, source: 'unknown' as const }, action: 'clarify' },
        { attention: { ...policy, source: 'past-recollection' as const }, action: 'clarify' },
        {
          attention: { ...policy, scope: 'target' as const, ambiguousTarget: true },
          action: 'clarify',
        },
        { attention: policy, action: 'fresh-view' },
      ];
      for (const [index, scenario] of cases.entries()) {
        const said = `Describe the whole view, Synthetic Case ${index}.`;
        const next = await boopy.utter(view.id, {
          speech: { text: said },
          attention: scenario.attention,
        });
        assert.equal(next.attention?.action, scenario.action);
        assert.equal(next.utterances.at(-1)?.text, said);
        assert.deepEqual(calls, zero);
        assert.deepEqual(new Boopy(deps).view(view.id).attention, next.attention);
      }
      assert.equal(
        journal.all().filter((event) => event.type === 'attention.decided').length,
        cases.length,
      );
    } finally {
      journal.close();
    }
  });

  it('inspects explicitly supplied views honestly but refuses cached untrusted reuse and source relabeling', async () => {
    const { boopy, calls, inputs, reset, journal } = setup();
    try {
      const view = await boopy.start(startRequest('Describe this trip.'));
      reset();
      const frame = {
        ...frameOf(),
        source: 'current-surroundings' as const,
        timestampTrusted: false,
      };
      const fresh = await boopy.utter(view.id, {
        frame,
        speech: { text: 'Describe the whole view.' },
        attention: policy,
      });
      assert.equal(fresh.attention?.action, 'reuse');
      assert.equal(fresh.attention?.observationId, fresh.observations.at(-1)?.id);
      assert.match(fresh.attention?.reason ?? '', /not proof.*current scene or capture time/);
      assert.equal(calls.interpretation, 1);
      assert.equal(calls.ocr, 0);
      assert.equal(calls.segmentation, 0);
      assert.equal(inputs.at(-1)?.scope, 'scene');
      reset();
      const cached = await boopy.utter(view.id, {
        speech: { text: 'Describe the whole view again.' },
        attention: policy,
      });
      assert.equal(cached.attention?.action, 'fresh-view');
      const wrong = await boopy.utter(view.id, {
        speech: { text: 'Describe the whole view.' },
        attention: { ...policy, source: 'past-recollection' },
      });
      assert.equal(wrong.attention?.action, 'clarify');
      assert.deepEqual(calls, zero);
    } finally {
      journal.close();
    }
  });

  it('does not fall back from missing selected IDs or accept supplied trusted future evidence', async () => {
    const { boopy, journal, calls, reset } = setup();
    try {
      const view = await boopy.start(startRequest('Describe this trip.'));
      reset();
      const missing = await boopy.utter(view.id, {
        speech: { text: 'Describe the whole view.' },
        attention: { ...policy, observationId: 'synthetic-missing' },
      });
      assert.equal(missing.attention?.action, 'clarify');
      assert.equal(missing.attention?.observationId, null);
      const future = await boopy.utter(view.id, {
        speech: { text: 'Describe the whole view.' },
        attention: policy,
        frame: {
          ...frameOf(),
          source: 'current-surroundings',
          timestampTrusted: true,
          capturedAt: '2099-01-01T00:00:00.000Z',
        },
      });
      assert.equal(future.attention?.action, 'clarify');
      assert.deepEqual(calls, zero);
      const untyped = await boopy.utter(view.id, {
        speech: { text: 'Describe the whole view.' },
        attention: policy,
        frame: frameOf(),
      });
      assert.equal(untyped.attention?.action, 'fresh-view');
      assert.deepEqual(calls, zero);
    } finally {
      journal.close();
    }
  });

  it('reuses trusted selected sources with bounded requested OCR and preserves human notes through commit/replay', async () => {
    const { boopy, deps, journal, calls, reset } = setup();
    try {
      const request = startRequest('Describe this trip.');
      const view = await boopy.start(request);
      reset();
      const trusted = {
        ...frameOf(),
        source: 'displayed-image' as const,
        timestampTrusted: true,
        capturedAt: '1970-01-01T18:00:00.000Z',
      };
      const attention = {
        ...policy,
        source: 'displayed-image' as const,
        maxAgeMs: 60000,
        ocrRequested: true,
      };
      const fresh = await boopy.utter(view.id, {
        frame: trusted,
        speech: { text: 'Describe the whole picture.' },
        attention,
      });
      assert.equal(fresh.attention?.action, 'reuse');
      assert.equal(calls.ocr, 1);
      assert.equal(calls.segmentation, 0);
      reset();
      const cached = await boopy.utter(view.id, {
        speech: { text: 'Describe the whole picture again.' },
        attention: {
          ...attention,
          observationId: fresh.observations.at(-1)?.id,
          ocrRequested: false,
        },
      });
      assert.equal(cached.attention?.action, 'reuse');
      assert.equal(calls.interpretation, 1);
      assert.equal(calls.ocr, 0);
      reset();
      const segmented = await boopy.utter(view.id, {
        speech: { text: 'Describe the whole picture boundary.' },
        attention: {
          ...attention,
          observationId: fresh.observations.at(-1)?.id,
          ocrRequested: false,
          segmentationRequested: true,
        },
      });
      assert.equal(calls.interpretation, 1);
      assert.equal(calls.ocr, 0);
      assert.ok(calls.segmentation > 0 && calls.segmentation <= 4);
      reset();
      const target = segmented.items.find((item) => item.kind === 'object');
      assert.ok(target);
      const note = 'I felt Much Colder on that Trip.';
      const noted = await boopy.utter(view.id, {
        speech: { text: note },
        cues: { targetItemId: target.id },
        attention: { ...policy, evidence: 'none' },
      });
      assert.equal(noted.items.find((item) => item.id === target.id)?.note, note);
      assert.deepEqual(calls, zero);
      const committed = boopy.commit(view.id);
      const pkg = boopy.package(committed.committed?.packageId ?? '');
      assert.ok(pkg);
      assert.ok(pkg.items.some((item) => item.note === note));
      assert.deepEqual(new Boopy(deps).package(pkg.id), pkg);
      assert.deepEqual(new Boopy(deps).view(view.id).attention, noted.attention);
    } finally {
      journal.close();
    }
  });
});
