import assert from 'node:assert/strict';
import { it } from 'node:test';
import { outlineFrames } from './recorded-outlines.ts';

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
