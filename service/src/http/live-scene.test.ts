import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { it } from 'node:test';
import sharp from 'sharp';
import { Journal } from '../journal.ts';
import { LiveObservation, type ScenePerceiver } from '../live-observation.ts';
import { testBoopy } from '../testing.ts';
import { headsetApp } from './headset.ts';

const proposed = {
  objects: [
    {
      label: 'synthetic rectangle',
      confidence: 0.6,
      box: { x0: 0.1, y0: 0.2, x1: 0.9, y1: 0.8 },
      contour: [
        { x: 0.1, y: 0.2 },
        { x: 0.9, y: 0.2 },
        { x: 0.9, y: 0.8 },
        { x: 0.1, y: 0.8 },
      ],
    },
  ],
  latencyMs: 12,
};
async function syntheticRequest() {
  const bytes = await sharp({
    create: { width: 64, height: 48, channels: 3, background: '#dddddd' },
  })
    .jpeg()
    .toBuffer();
  return {
    streamId: 'c866cd97-4269-4fbe-a74f-22a105033c15',
    frameId: '2a62bffd-fd27-444b-943c-cbcc50f4c638',
    sequence: 7,
    frame: {
      jpeg: bytes.toString('base64'),
      width: 64,
      height: 48,
      capturedAt: '1970-01-01T12:00:00.000Z',
    },
  };
}
function setup(enabled = true) {
  const test = testBoopy();
  const sceneJournal = Journal.open(':memory:');
  let calls = 0;
  const provider: ScenePerceiver = {
    provider: 'synthetic',
    model: 'synthetic-contour',
    observe: async () => {
      calls++;
      return proposed;
    },
  };
  const app = headsetApp(test.boopy, {
    logger: false,
    ...(enabled ? { liveScene: new LiveObservation(provider, sceneJournal) } : {}),
  });
  return {
    ...test,
    app,
    provider,
    sceneJournal,
    calls: () => calls,
    close: async () => {
      await app.close();
      sceneJournal.close();
      test.journal.close();
    },
  };
}
it('disabled scene observation refuses without creating a conversation or scene event', async () => {
  const test = setup(false);
  try {
    const response = await test.app.inject({
      method: 'POST',
      url: '/v1/scene/observe',
      payload: await syntheticRequest(),
    });
    assert.equal(response.statusCode, 503);
    assert.equal(test.calls(), 0);
    assert.equal(test.sceneJournal.all().length, 0);
    assert.equal(test.journal.all().length, 0);
  } finally {
    await test.close();
  }
});
it('a non-loopback host is denied before scene provider work', async () => {
  const test = setup();
  try {
    const response = await test.app.inject({
      method: 'POST',
      url: '/v1/scene/observe',
      headers: { host: 'malicious.example' },
      payload: await syntheticRequest(),
    });
    assert.equal(response.statusCode, 403);
    assert.equal(test.calls(), 0);
    assert.equal(test.sceneJournal.all().length, 0);
    assert.equal(test.journal.all().length, 0);
  } finally {
    await test.close();
  }
});
it('synthetic HTTP scene results echo exact frame identity and journal only proposed provenance, not pixels', async () => {
  const test = setup();
  try {
    const input = await syntheticRequest();
    const response = await test.app.inject({
      method: 'POST',
      url: '/v1/scene/observe',
      payload: input,
    });
    assert.equal(response.statusCode, 200);
    const result = response.json();
    for (const key of ['streamId', 'frameId', 'sequence'] as const)
      assert.equal(result[key], input[key]);
    for (const key of ['capturedAt', 'width', 'height'] as const)
      assert.equal(result[key], input.frame[key]);
    assert.equal(
      result.frameSha256,
      createHash('sha256').update(Buffer.from(input.frame.jpeg, 'base64')).digest('hex'),
    );
    assert.equal(result.verification, 'proposed');
    assert.equal(result.frameRetained, false);
    assert.equal(result.provider, 'synthetic');
    assert.equal(result.model, 'synthetic-contour');
    assert.deepEqual(result.objects, proposed.objects);
    assert.equal(test.calls(), 1);
    const events = test.sceneJournal.all();
    assert.equal(events.length, 1);
    assert.equal(events[0]?.id, result.eventId);
    assert.equal(events[0]?.type, 'scene.observed');
    assert.equal(test.journal.all().length, 0);
    for (const serialized of [response.body, JSON.stringify(events)]) {
      assert.ok(!serialized.includes(input.frame.jpeg));
      assert.doesNotMatch(serialized, /"jpeg"|"wav"|"confirmed"/);
    }
  } finally {
    await test.close();
  }
});
it('mismatched dimensions are rejected before provider work and journaling', async () => {
  const test = setup();
  try {
    const input = await syntheticRequest();
    const response = await test.app.inject({
      method: 'POST',
      url: '/v1/scene/observe',
      payload: { ...input, frame: { ...input.frame, width: 65 } },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, 'scene_frame');
    assert.equal(test.calls(), 0);
    assert.equal(test.sceneJournal.all().length, 0);
    assert.equal(test.journal.all().length, 0);
  } finally {
    await test.close();
  }
});
it('malformed provider contours never become scene events or conversation context', async () => {
  const test = setup();
  try {
    const originalObserve = test.provider.observe;
    test.provider.observe = async (jpeg, signal) => {
      await originalObserve(jpeg, signal);
      return {
        ...proposed,
        objects: [
          {
            ...proposed.objects[0],
            label: 'synthetic malformed contour',
            confidence: 0.6,
            box: { x0: 0.1, y0: 0.2, x1: 0.9, y1: 0.8 },
            contour: [
              { x: -0.1, y: 0.2 },
              { x: 0.9, y: 0.2 },
              { x: 0.9, y: 0.8 },
            ],
          },
        ],
      };
    };
    const response = await test.app.inject({
      method: 'POST',
      url: '/v1/scene/observe',
      payload: await syntheticRequest(),
    });
    assert.equal(response.statusCode, 400);
    assert.equal(test.calls(), 1);
    assert.equal(test.sceneJournal.all().length, 0);
    assert.equal(test.journal.all().length, 0);
  } finally {
    await test.close();
  }
});
