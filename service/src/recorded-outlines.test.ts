import assert from 'node:assert/strict';
import { it } from 'node:test';
import { bestOutline, outlineFrames, overlap } from './recorded-outlines.ts';

// Synthetic stills: one byte names the frame, and the fake worker names what it saw after it.
const still = (marker: number) => Buffer.from([0xff, 0xd8, marker, 0xff, 0xd9]);
const outline = (label: string) => ({
  label,
  confidence: 0.5,
  origin: label === 'kite' ? 'proposed' : 'base',
  box: { x0: 0.1, y0: 0.1, x1: 0.4, y1: 0.4 },
  contour: [
    { x: 0.1, y: 0.1 },
    { x: 0.4, y: 0.1 },
    { x: 0.2, y: 0.4 },
  ],
});

it('keeps every outline on the frame it was made from, and leaves a failed frame empty', async () => {
  const frames = [1, 2, 3, 4].map((marker) => ({ frameId: `rfr_${marker}`, jpeg: still(marker) }));
  const seen: { marker: number; nouns: readonly string[] }[] = [];
  const run = await outlineFrames(
    frames,
    async (jpeg, _signal, nouns) => {
      const marker = jpeg[2] as number;
      seen.push({ marker, nouns });
      if (marker === 2) throw new Error('synthetic worker failure');
      return { objects: [outline(marker === 3 ? 'kite' : `thing ${marker}`)], latencyMs: marker };
    },
    ['kite'],
  );
  // One frame at a time, in order, each with the proposed nouns.
  assert.deepEqual(
    seen.map((call) => call.marker),
    [1, 2, 3, 4],
  );
  assert.ok(seen.every((call) => call.nouns.join() === 'kite'));
  assert.deepEqual(run.failed, ['rfr_2']);
  assert.deepEqual(
    run.outlined.map((frame) => [frame.frameId, frame.objects[0]?.label, frame.objects[0]?.origin]),
    [
      ['rfr_1', 'thing 1', 'base'],
      ['rfr_3', 'kite', 'proposed'],
      ['rfr_4', 'thing 4', 'base'],
    ],
  );
  assert.equal(run.outlined[1]?.latencyMs, 3);
});

it('takes the shape of the outline that overlaps the item by half or more, a matching noun first', () => {
  const item = { label: 'Quad bike', box: { x0: 0.2, y0: 0.2, x1: 0.6, y1: 0.6 } };
  const motorcycle = { label: 'motorcycle', box: { x0: 0.2, y0: 0.2, x1: 0.6, y1: 0.62 } };
  const quad = { label: 'quad bike', box: { x0: 0.22, y0: 0.2, x1: 0.62, y1: 0.6 } };
  const far = { label: 'quad bike', box: { x0: 0.7, y0: 0.7, x1: 0.9, y1: 0.9 } };
  assert.equal(bestOutline(item, [motorcycle, quad, far])?.object, quad);
  // Without a matching noun the largest overlap wins; an outline already used is not reused.
  assert.equal(bestOutline(item, [motorcycle, far])?.object, motorcycle);
  assert.equal(bestOutline(item, [motorcycle, quad], new Set([quad]))?.object, motorcycle);
  // Under half an overlap, nothing qualifies and the item keeps its box.
  assert.equal(
    bestOutline(item, [far, { label: 'quad bike', box: { x0: 0.4, y0: 0.4, x1: 0.8, y1: 0.8 } }]),
    null,
  );
  assert.ok(Math.abs(overlap(item.box, item.box) - 1) < 1e-9);
});
