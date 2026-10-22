import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import sharp from 'sharp';
import { Journal } from './journal.ts';
import {
  LiveObservation,
  type SceneObservationRequest,
  type ScenePerceiver,
} from './live-observation.ts';

const result = {
  objects: [
    {
      label: 'synthetic shape',
      confidence: 0.6,
      box: { x0: 0.1, y0: 0.1, x1: 0.9, y1: 0.9 },
      contour: [
        { x: 0.1, y: 0.1 },
        { x: 0.9, y: 0.1 },
        { x: 0.9, y: 0.9 },
        { x: 0.1, y: 0.9 },
      ],
    },
  ],
  latencyMs: 12,
};
async function request(): Promise<SceneObservationRequest> {
  return {
    streamId: randomUUID(),
    frameId: randomUUID(),
    sequence: 0,
    frame: {
      jpeg: (
        await sharp({ create: { width: 64, height: 48, channels: 3, background: '#dddddd' } })
          .jpeg()
          .toBuffer()
      ).toString('base64'),
      width: 64,
      height: 48,
      capturedAt: new Date().toISOString(),
    },
  };
}
test('live proposals retain frame identity and provenance without pixels or human verification', async () => {
  const journal = Journal.open(':memory:');
  const provider: ScenePerceiver = {
    provider: 'synthetic',
    model: 'synthetic-mask',
    observe: async () => result,
  };
  try {
    const input = await request();
    const output = await new LiveObservation(provider, journal).observe(input);
    assert.equal(output.frameId, input.frameId);
    assert.equal(output.verification, 'proposed');
    assert.equal(output.frameRetained, false);
    assert.equal(output.objects.length, 1);
    const events = journal.all();
    assert.equal(events.length, 1);
    assert.equal(events[0]?.type, 'scene.observed');
    assert.ok(!JSON.stringify(events).includes(input.frame.jpeg));
    assert.ok(!JSON.stringify(events).includes('confirmed'));
  } finally {
    journal.close();
  }
});
test('concurrent frames are rejected instead of queued and invalid geometry is not journaled', async () => {
  const journal = Journal.open(':memory:');
  let release: (value: typeof result) => void = () => {};
  const provider: ScenePerceiver = {
    provider: 'fixture',
    model: 'fixture',
    observe: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  };
  const scene = new LiveObservation(provider, journal);
  const input = await request();
  const first = scene.observe(input);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await assert.rejects(scene.observe(input), /already in progress/);
  release(result);
  await first;
  provider.observe = async () => ({
    ...result,
    objects: [
      {
        ...result.objects[0],
        label: 'shape',
        box: { x0: 0.1, y0: 0.1, x1: 0.9, y1: 0.9 },
        contour: [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
          { x: 0, y: 1 },
        ],
        confidence: 2,
      },
    ],
  });
  await assert.rejects(scene.observe(await request()));
  assert.equal(journal.all().length, 1);
  journal.close();
});
test('aborted and mismatched images never produce scene events', async () => {
  const journal = Journal.open(':memory:');
  let called = false;
  const scene = new LiveObservation(
    {
      provider: 'fixture',
      model: 'fixture',
      observe: async () => {
        called = true;
        return result;
      },
    },
    journal,
  );
  const input = await request();
  await assert.rejects(
    scene.observe({ ...input, frame: { ...input.frame, width: 65 } }),
    /dimensions/,
  );
  const cancel = new AbortController();
  cancel.abort();
  await assert.rejects(scene.observe(input, cancel.signal));
  assert.equal(called, false);
  assert.equal(journal.all().length, 0);
  journal.close();
});
