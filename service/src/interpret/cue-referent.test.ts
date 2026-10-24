import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Boopy } from '../boopy.ts';
import type { Cues, DepthGrid, Item } from '../contracts.ts';
import { startRequest, testBoopy } from '../testing.ts';
import { cueReferent } from './cue-referent.ts';
import { FixtureInterpreter } from './fixture.ts';
import type { ModelOutput } from './output.ts';

type Area = readonly [number, number, number, number];
const OBS = 'obs_1';

function item(id: string, box: Area | null, extra: Partial<Item> = {}): Item {
  return {
    id,
    kind: 'object',
    label: 'synthetic thing',
    statement: 'A synthetic thing.',
    grounding:
      box === null
        ? { kind: 'scene' }
        : {
            kind: 'box',
            observationId: OBS,
            box: { x0: box[0], y0: box[1], x1: box[2], y1: box[3] },
          },
    confidence: 0.6,
    origin: 'model',
    status: 'proposed',
    emphasis: false,
    interpretationId: 'int_1',
    ...extra,
  };
}

/** A 16 by 12 depth grid: the room at 2.5 m, and the cells whose centers lie in `near` closer. */
function depth(near: Area | null, meters = 0.4): DepthGrid {
  const columns = 16;
  const rows = 12;
  return {
    columns,
    rows,
    meters: Array.from({ length: columns * rows }, (_, index) => {
      const x = ((index % columns) + 0.5) / columns;
      const y = (Math.floor(index / columns) + 0.5) / rows;
      const inside = near !== null && x >= near[0] && x <= near[2] && y >= near[1] && y <= near[3];
      return inside ? meters : 2.5;
    }),
  };
}

const gaze = (x: number, y: number, onSurface = true): Cues => ({
  gaze: { point: { x, y }, onSurface },
});
const CUP: Area = [0.4, 0.4, 0.6, 0.7];
const LAMP: Area = [0.7, 0.1, 0.9, 0.3];
const items = [item('cup', CUP), item('lamp', LAMP)];
const pick = (cues: Cues, grid: DepthGrid | null, candidates: readonly Item[] = items) =>
  cueReferent(candidates, { id: OBS, cues, depth: grid });

describe('a subject from the person’s near cue', () => {
  it('names the one box that holds a cue held up close', () => {
    assert.deepEqual(pick(gaze(0.5, 0.5), depth(CUP)), {
      itemId: 'cup',
      referentCue: { cue: 'gaze', meters: 0.4 },
    });
  });

  it('names nothing when the cue meets the room behind', () => {
    assert.equal(pick(gaze(0.5, 0.5), depth(null)), null);
  });

  it('counts a cue at most 0.8 m away and no farther', () => {
    assert.equal(pick(gaze(0.5, 0.5), depth(CUP, 0.8))?.itemId, 'cup');
    assert.equal(pick(gaze(0.5, 0.5), depth(CUP, 0.81)), null);
  });

  it('names nothing when two boxes or no box hold the cue', () => {
    const overlapping = [...items, item('saucer', [0.45, 0.45, 0.65, 0.75])];
    assert.equal(pick(gaze(0.5, 0.5), depth(CUP), overlapping), null);
    assert.equal(pick(gaze(0.2, 0.8), depth([0.1, 0.7, 0.3, 0.9])), null);
  });

  it('names nothing when a far box only encloses something near the model did not propose', () => {
    const table = item('table', [0.1, 0.3, 0.9, 0.95]);
    assert.equal(pick(gaze(0.5, 0.5), depth([0.45, 0.45, 0.55, 0.6]), [table]), null);
  });

  it('names nothing without depth at the cue or a surface under it', () => {
    assert.equal(pick(gaze(0.5, 0.5), null), null);
    const unknown = depth(CUP);
    const cell = Math.floor(0.5 * 12) * 16 + Math.floor(0.5 * 16);
    assert.equal(
      pick(gaze(0.5, 0.5), { ...unknown, meters: unknown.meters.with(cell, null) }),
      null,
    );
    assert.equal(pick(gaze(0.5, 0.5, false), depth(CUP)), null);
  });

  it('names nothing when two near cues fall in different boxes, and the pointer when they agree', () => {
    const near = depth(null).meters.map((meters, index) => {
      const x = ((index % 16) + 0.5) / 16;
      const y = (Math.floor(index / 16) + 0.5) / 12;
      const inside = (area: Area) => x >= area[0] && x <= area[2] && y >= area[1] && y <= area[3];
      return inside(CUP) || inside(LAMP) ? 0.5 : meters;
    });
    const grid = { columns: 16, rows: 12, meters: near };
    const apart: Cues = {
      ...gaze(0.5, 0.5),
      pointer: { point: { x: 0.8, y: 0.2 }, onSurface: true, hand: 'right' },
    };
    assert.equal(pick(apart, grid), null);
    const together: Cues = {
      ...gaze(0.5, 0.5),
      pointer: { point: { x: 0.55, y: 0.6 }, onSurface: true, hand: 'right' },
    };
    assert.deepEqual(pick(together, grid), {
      itemId: 'cup',
      referentCue: { cue: 'pointer', meters: 0.5 },
    });
  });

  it('ignores a far pointer, such as the talking hand’s ray on the frame’s top row', () => {
    const cues: Cues = {
      ...gaze(0.5, 0.5),
      pointer: { point: { x: 0.55, y: 0.01 }, onSurface: true, hand: 'right' },
    };
    assert.deepEqual(pick(cues, depth(CUP)), {
      itemId: 'cup',
      referentCue: { cue: 'gaze', meters: 0.4 },
    });
  });

  it('takes only object or text boxes on this view', () => {
    for (const other of [
      item('goal', CUP, { kind: 'goal' }),
      item('note', CUP, { kind: 'note' }),
      item('question', CUP, { kind: 'question' }),
      item('topic', CUP, { kind: 'topic' }),
      item('scene', null),
      item('earlier', CUP, {
        grounding: {
          kind: 'box',
          observationId: 'obs_0',
          box: { x0: 0.4, y0: 0.4, x1: 0.6, y1: 0.7 },
        },
      }),
    ])
      assert.equal(pick(gaze(0.5, 0.5), depth(CUP), [other]), null, other.id);
    assert.equal(
      pick(gaze(0.5, 0.5), depth(CUP), [item('label', CUP, { kind: 'text' })])?.itemId,
      'label',
    );
  });
});

/** The recorded fixture with the reply a model gives and, by default, no subject named. */
function modelNaming(key: string | null = null) {
  const fixture = new FixtureInterpreter();
  return {
    provider: fixture.provider,
    model: fixture.model,
    async interpret(input: Parameters<FixtureInterpreter['interpret']>[0]) {
      const recorded = (await fixture.interpret(input)).output;
      const output: ModelOutput = {
        ...recorded,
        referent: { ...recorded.referent, key: input.scope === 'scene' ? null : key },
        response: 'It looks like a photo.',
        followUps: [{ question: 'Where was it taken?' }],
      };
      return { output, raw: JSON.stringify(output) };
    },
  };
}

/** The fixture centers its photo box on the cue; the person holds it 0.4 m away. */
function heldUp(said = 'What is this?', near: Area | null = [0.25, 0.38, 0.65, 0.72]) {
  const request = startRequest(said);
  return { ...request, frame: { ...request.frame, depth: depth(near) } };
}

function proposed(test: ReturnType<typeof testBoopy>) {
  const event = test.journal.all().find((entry) => entry.type === 'interpretation.proposed');
  assert.ok(event?.type === 'interpretation.proposed');
  return event.data;
}

describe('a turn whose model names no subject', () => {
  it('takes the box that holds the near cue, keeps the model’s item and output, and replays', async () => {
    const test = testBoopy({ interpreter: modelNaming() });
    const view = await test.boopy.start(heldUp());
    const data = proposed(test);
    const photo = data.items.find((entry) => entry.id.endsWith('.photo'));
    assert.ok(photo !== undefined);
    assert.equal(view.referentId, photo.id);
    assert.deepEqual(data.referentCue, { cue: 'gaze', meters: 0.4 });
    const shown = view.items.find((entry) => entry.id === photo.id);
    assert.equal(shown?.status, 'proposed');
    assert.equal(shown?.origin, 'model');
    assert.equal(shown?.confidence, photo.confidence);
    assert.equal(JSON.parse(data.raw).referent.key, null);
    // The model never said its reply or its follow-ups are about the item the cue chose.
    assert.equal(
      view.relations.some((relation) => relation.from.endsWith('.__reply')),
      false,
    );
    assert.deepEqual(
      data.actions?.map((action) => action.targetItemId),
      [null],
    );
    const replayed = new Boopy({ ...test.deps }).view(view.id);
    assert.equal(replayed.referentId, photo.id);
  });

  it('leaves the subject unknown when the near patch is not at the cue', async () => {
    const test = testBoopy({ interpreter: modelNaming() });
    const view = await test.boopy.start(heldUp('What is this?', null));
    assert.equal(view.referentId, null);
    assert.equal('referentCue' in proposed(test), false);
  });

  it('keeps a subject the model named from its own items', async () => {
    const test = testBoopy({ interpreter: modelNaming('camels') });
    const view = await test.boopy.start(heldUp());
    assert.ok(view.referentId?.endsWith('.camels'));
    assert.equal('referentCue' in proposed(test), false);
  });

  it('takes no subject from the cue when the person asks about the whole scene', async () => {
    const test = testBoopy({ interpreter: modelNaming() });
    const view = await test.boopy.start(heldUp('Tell me about the whole scene.'));
    assert.equal(view.referentId, null);
    assert.equal('referentCue' in proposed(test), false);
  });
});
