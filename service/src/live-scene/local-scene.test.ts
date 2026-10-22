import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { LocalScenePerceiver } from './local-scene.ts';

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const object = {
  label: 'synthetic region',
  confidence: 0.4,
  box: { x0: 0.1, y0: 0.1, x1: 0.4, y1: 0.4 },
  contour: [
    { x: 0.1, y: 0.1 },
    { x: 0.4, y: 0.1 },
    { x: 0.2, y: 0.4 },
  ],
  maskConfidence: 0.9,
  maskSha256: 'a'.repeat(64),
  maskPixels: 300,
};
/**
 * Deadlines default to generous values so a slow worker start on a heavily loaded machine cannot
 * fail a test that is not about deadlines; a test about a deadline makes only that one short.
 */
async function fixture(mode = 'normal', deadlines: { startup?: number; inference?: number } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'boopy-local-scene-'));
  const workerPath = join(directory, 'worker.mjs');
  await writeFile(
    workerPath,
    `import {createInterface} from 'node:readline';
const mode=${JSON.stringify(mode)};if(mode==='slow-start')await new Promise(r=>setTimeout(r,750));
if(mode!=='no-ready')console.log(JSON.stringify({type:'ready',device:'cpu'}));
let count=0;for await(const line of createInterface({input:process.stdin})){
 const request=JSON.parse(line);count++;if(mode==='slow')await new Promise(r=>setTimeout(r,150));
 if(mode==='late')await new Promise(r=>setTimeout(r,60000));
 if(mode==='malformed'){console.log('not json');continue;}
 console.log(JSON.stringify({type:'result',id:mode==='wrong-id'?request.id+1:request.id,objects:[${JSON.stringify(object)}],latencyMs:count}));
}`,
  );
  const provider = new LocalScenePerceiver({
    python: process.execPath,
    workerPath,
    detectorModel: 'synthetic-detector',
    segmenterModel: 'synthetic-masks',
    startupTimeoutMs: deadlines.startup ?? 30_000,
    inferenceTimeoutMs: deadlines.inference ?? 30_000,
  });
  return {
    provider,
    close: async () => {
      await provider.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
test('persistent local worker returns contour metadata without altering uncertainty', async () => {
  const f = await fixture();
  try {
    await f.provider.ready();
    assert.equal(f.provider.device, 'cpu');
    const first = await f.provider.observe(jpeg);
    const second = await f.provider.observe(jpeg);
    assert.deepEqual(first.objects, [object]);
    assert.equal(first.latencyMs, 1);
    assert.equal(second.latencyMs, 2);
    assert.equal(first.objects[0]?.confidence, 0.4);
    assert.equal(first.objects[0]?.maskConfidence, 0.9);
  } finally {
    await f.close();
  }
});
test('a worker that starts slowly, as on a heavily loaded machine, still serves frames', async () => {
  const f = await fixture('slow-start');
  try {
    const result = await f.provider.observe(jpeg);
    assert.deepEqual(result.objects, [object]);
    assert.equal(f.provider.device, 'cpu');
  } finally {
    await f.close();
  }
});
test('rejects simultaneous frames instead of queueing stale views', async () => {
  const f = await fixture('slow');
  try {
    const first = f.provider.observe(jpeg);
    await assert.rejects(f.provider.observe(jpeg), /already processing/);
    await first;
  } finally {
    await f.close();
  }
});
test('cancellation discards delayed results and next explicit frame starts a fresh worker', async () => {
  const f = await fixture('slow');
  try {
    await f.provider.ready();
    const stop = new AbortController();
    const pending = f.provider.observe(jpeg, stop.signal);
    stop.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(f.provider.device, null);
    const fresh = await f.provider.observe(jpeg);
    assert.equal(fresh.latencyMs, 1);
  } finally {
    await f.close();
  }
});
test('startup, inference, malformed and wrong-identity replies cannot become contours', async () => {
  // Each case fails for its own reason: only the deadline under test is short. The late worker
  // answers a minute after the request, so on a loaded machine its reply still cannot beat the
  // 100 ms inference deadline.
  for (const [mode, deadlines, reason] of [
    ['no-ready', { startup: 50 }, /startup timed out/],
    ['late', { inference: 100 }, /inference timed out/],
    ['malformed', {}, /invalid response/],
    ['wrong-id', {}, /no valid masks/],
  ] as const) {
    const f = await fixture(mode, deadlines);
    try {
      await assert.rejects(f.provider.observe(jpeg), reason, mode);
    } finally {
      await f.close();
    }
  }
});
test('missing runtime and invalid media fail without leaking frame bytes', async () => {
  const provider = new LocalScenePerceiver({
    python: '/synthetic/nonexistent-runtime',
    detectorModel: 'a',
    segmenterModel: 'b',
  });
  try {
    await assert.rejects(
      provider.observe(Buffer.from('synthetic private payload')),
      /bounded JPEG/,
    );
    await assert.rejects(provider.ready(), /could not start/);
  } finally {
    await provider.close();
  }
  await assert.rejects(provider.ready(), /closed/);
});
