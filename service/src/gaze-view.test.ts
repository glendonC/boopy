import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import { fromView, gazeView, intoView, pointFromView } from './evidence.ts';

async function frame(width: number, height: number) {
  return sharp({ create: { width, height, channels: 3, background: { r: 200, g: 180, b: 120 } } })
    .jpeg()
    .toBuffer();
}

test('the gaze view is 40 percent of each side, centred on the gaze and kept inside the frame', async () => {
  const jpeg = await frame(1000, 1250);
  const centred = await gazeView(jpeg, { x: 0.5, y: 0.5 });
  assert.deepEqual(centred.region, { x0: 0.3, y0: 0.3, x1: 0.7, y1: 0.7 });
  const size = await sharp(centred.image).metadata();
  assert.deepEqual([size.width, size.height], [400, 500]);
  const corner = await gazeView(jpeg, { x: 0.95, y: 0.02 });
  assert.deepEqual(corner.region, { x0: 0.6, y0: 0, x1: 1, y1: 0.4 });
});

function near(actual: Record<string, number> | null, expected: Record<string, number>) {
  assert.ok(actual !== null);
  for (const key of Object.keys(expected))
    assert.ok(Math.abs((actual[key] ?? Number.NaN) - (expected[key] ?? 0)) < 1e-9, key);
}

test('boxes and points map exactly between the view and the frame', () => {
  const region = { x0: 0.6, y0: 0.2, x1: 1, y1: 0.6 };
  near(fromView({ x0: 0, y0: 0, x1: 1, y1: 1 }, region), region);
  const box = { x0: 0.25, y0: 0.5, x1: 0.5, y1: 0.75 };
  const inFrame = fromView(box, region);
  near(inFrame, { x0: 0.7, y0: 0.4, x1: 0.8, y1: 0.5 });
  near(intoView(inFrame, region), box);
  assert.equal(intoView({ x0: 0, y0: 0, x1: 0.1, y1: 0.1 }, region), null);
  near(intoView({ x0: 0.5, y0: 0.1, x1: 0.7, y1: 0.3 }, region), {
    x0: 0,
    y0: 0,
    x1: 0.25,
    y1: 0.25,
  });
  near(pointFromView({ x: 0.5, y: 0.5 }, region), { x: 0.8, y: 0.4 });
});
