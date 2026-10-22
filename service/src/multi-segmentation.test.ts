import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Boopy } from './boopy.ts';
import { FixtureInterpreter } from './interpret/fixture.ts';
import type { Interpreter, InterpretInput } from './interpret/interpreter.ts';
import type { Segmenter, SegmentInput } from './segmentation.ts';
import { startRequest, testBoopy } from './testing.ts';

describe('one capture, several grounded proposals', () => {
  it('respects an explicit whole-scene first utterance and journals its scope before interpretation', async () => {
    let scope: InterpretInput['scope'] | undefined;
    const fixture = new FixtureInterpreter();
    const interpreter: Interpreter = {
      provider: 'test',
      model: 'scene-discovery',
      interpret: async (input) => {
        scope = input.scope;
        return fixture.interpret(input);
      },
    };
    const calls: SegmentInput[] = [];
    const segmenter: Segmenter = {
      provider: 'meta',
      model: 'sam-3.1',
      segment: async (input) => {
        calls.push(input);
        return { outcome: 'no-match', latencyMs: 1, confidence: null };
      },
    };
    const { boopy, journal, deps } = testBoopy({ interpreter, segmenter });
    const view = await boopy.start(startRequest('Use the whole scene to practice Korean.'));
    assert.equal(scope, 'scene');
    assert.equal(view.scope, 'scene');
    assert.equal(view.referentId, null);
    assert.equal(calls.length, 3, 'scene discovery keeps the photo, camels and tents separately');
    assert.ok(calls.every((input) => input.focus === null));
    assert.equal(journal.all().filter((e) => e.type === 'grounding.refined').length, 3);
    const correction = journal.all().find((e) => e.type === 'item.corrected');
    assert.equal(correction?.type === 'item.corrected' && correction.data.op, 'rescope');
    assert.ok(
      journal.all().findIndex((e) => e.type === 'item.corrected') <
        journal.all().findIndex((e) => e.type === 'interpretation.proposed'),
    );
    assert.ok(view.items.every((item) => item.status === 'proposed'));
    assert.deepEqual(new Boopy(deps).view(view.id).items, view.items);
  });
  it('keeps a targeted first utterance targeted while refining other boxed items without its cue', async () => {
    const calls: SegmentInput[] = [];
    const segmenter: Segmenter = {
      provider: 'meta',
      model: 'sam-3.1',
      segment: async (input) => {
        calls.push(input);
        return { outcome: 'no-match', latencyMs: 1, confidence: null };
      },
    };
    const { boopy, journal } = testBoopy({ segmenter });
    const view = await boopy.start(startRequest('Help me talk about this trip.'));
    assert.equal(view.scope, 'object');
    assert.ok(view.referentId !== null);
    assert.equal(calls[0]?.concept, 'Desert photo');
    assert.deepEqual(calls[0]?.focus, { x: 0.45, y: 0.55 });
    assert.ok(calls.slice(1).every((input) => input.focus === null));
    assert.equal(journal.all().filter((e) => e.type === 'item.corrected').length, 0);
  });
  it('caps four fresh boxed objects/text items, retains omitted proposals and records per-item provenance', async () => {
    const fixture = new FixtureInterpreter();
    const interpreter: Interpreter = {
      provider: 'test',
      model: 'synthetic-many-items',
      interpret: async (input) => {
        const result = await fixture.interpret(input);
        result.output.items = Array.from({ length: 7 }, (_, i) => ({
          key: `item${i}`,
          kind: i === 1 ? 'text' : 'object',
          label: `Object ${i}`,
          gloss: null,
          statement: 'Synthetic object.',
          box: [100 + i * 100, 100, 180 + i * 100, 200],
          point: null,
          scene: false,
          confidence: 0.4,
          why: 'Synthetic fixture.',
        }));
        result.output.referent.key = 'item3';
        return result;
      },
    };
    const calls: SegmentInput[] = [];
    const segmenter: Segmenter = {
      provider: 'meta',
      model: 'sam-3.1',
      segment: async (input) => {
        calls.push(input);
        return {
          outcome: 'contour',
          latencyMs: 2,
          confidence: null,
          contour: [
            { x: input.box.x0, y: input.box.y0 },
            { x: input.box.x1, y: input.box.y0 },
            { x: input.box.x1, y: input.box.y1 },
          ],
          mask: Buffer.from(`synthetic ${input.concept}`),
        };
      },
    };
    const { boopy, journal } = testBoopy({ interpreter, segmenter });
    const view = await boopy.start(startRequest('Tell me about this.'));
    assert.equal(calls.length, 4);
    assert.equal(calls[0]?.concept, 'Object 3');
    assert.ok(
      calls.some((input) => input.concept === 'Object 1'),
      'text-bearing item is eligible',
    );
    const physical = view.items.filter((item) => item.kind === 'object' || item.kind === 'text');
    assert.equal(physical.length, 7);
    assert.equal(physical.filter((item) => item.grounding.contour !== undefined).length, 4);
    assert.ok(physical.every((item) => item.status === 'proposed' && item.confidence === 0.4));
    assert.ok(
      physical
        .filter((item) => item.grounding.spatial !== undefined)
        .every(
          (item) =>
            item.grounding.spatial?.confidence === null &&
            item.grounding.spatial?.verification === 'proposed' &&
            item.grounding.spatial?.utteranceId === view.utterances[0]?.id &&
            item.grounding.box !== undefined,
        ),
    );
    assert.equal(journal.all().filter((e) => e.type === 'grounding.refined').length, 4);
    assert.match(view.notice ?? '', /3 more objects kept as approximate boxes/);
    const committed = boopy.commit(view.id);
    const pkg = boopy.package(committed.committed?.packageId ?? '');
    assert.equal(pkg?.items.filter((item) => item.grounding.contour !== undefined).length, 4);
    assert.ok(pkg?.items.every((item) => item.verification === 'accepted'));
  });
  it('does not refine preserved confirmed items during a later whole-scene interpretation', async () => {
    let calls = 0;
    const segmenter: Segmenter = {
      provider: 'meta',
      model: 'sam-3.1',
      segment: async () => {
        calls++;
        return { outcome: 'no-match', latencyMs: 1, confidence: null };
      },
    };
    const { boopy } = testBoopy({ segmenter });
    const view = await boopy.start(startRequest('Help me talk about this.'));
    assert.equal(calls, 3);
    const photo = view.items.find((item) => item.id === view.referentId);
    assert.ok(photo);
    boopy.act(view.id, { itemId: photo.id, action: 'confirm' });
    const again = await boopy.utter(view.id, { speech: { text: 'Use the whole scene' } });
    assert.equal(calls, 5, 'only the two fresh objects get another refinement');
    assert.equal(again.items.find((item) => item.id === photo.id)?.status, 'confirmed');
  });
});
