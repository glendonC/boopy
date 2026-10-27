import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Boopy } from '../boopy.ts';
import { HandoffPreparation } from '../handoff-preparation.ts';
import { TaskStore } from '../interaction/tasks.ts';
import { FixtureInterpreter } from '../interpret/fixture.ts';
import type { Interpreter, InterpretInput } from '../interpret/interpreter.ts';
import type { ModelOutput } from '../interpret/output.ts';
import { lensProjection, RecordedScenes } from '../recorded-source.ts';
import { startRequest, testBoopy } from '../testing.ts';
import { connectorApp } from './connector.ts';
import { headsetApp } from './headset.ts';

// The clips are made here from ffmpeg's test pattern; nothing is personal media.
const FFMPEG = '/opt/homebrew/bin/ffmpeg';
const TOKEN = 'synthetic-recorded-route-token';
const HOST = { host: '127.0.0.1' };
// Words Boopy's own lines must never use about a recorded frame (AUDIT RP-13).
const NOT_ABOUT_A_RECORDING = [' live', ' now', 'fresh', 'current', 'in your room', ' here'];

let directory: string;
let helper: string;
let clip: string;
let missing: string | false = false;

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'boopy-recorded-routes-'));
  const absent = [FFMPEG, '/usr/bin/swiftc'].filter(
    (file) => spawnSync(file, ['-version'], { timeout: 5000 }).error !== undefined,
  );
  if (absent.length) {
    missing = `Needs ${absent.join(', ')}; recorded routes were not proven.`;
    return;
  }
  helper = join(directory, 'boopy-recorded');
  const built = spawnSync('/usr/bin/swiftc', [
    '-O',
    '-o',
    helper,
    fileURLToPath(new URL('../../tools/recorded/main.swift', import.meta.url)),
  ]);
  assert.equal(built.status, 0, built.stderr?.toString().slice(0, 400));
  clip = join(directory, 'pattern.mov');
  const made = spawnSync(FFMPEG, [
    ...['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=96x64:rate=10', '-t', '1'],
    ...['-c:v', 'libx264', '-pix_fmt', 'yuv420p', clip],
  ]);
  assert.equal(made.status, 0, made.stderr?.toString().slice(0, 400));
});
after(async () => {
  await rm(directory, { recursive: true, force: true });
});

class CapturingInterpreter implements Interpreter {
  readonly provider = 'fixture';
  readonly model = 'recorded-desert-trip';
  readonly inputs: InterpretInput[] = [];
  /** Rewrites what the fixture would say about a turn, as a real model might answer. */
  change: ((output: ModelOutput) => ModelOutput) | null = null;
  readonly #fixture = new FixtureInterpreter();
  async interpret(input: InterpretInput) {
    this.inputs.push(input);
    const result = await this.#fixture.interpret(input);
    if (this.change === null) return result;
    const output = this.change(result.output);
    return { output, raw: JSON.stringify(output) };
  }
}

/** A stand-in scene worker that names each still by the start of its own SHA-256. */
const namingScene = {
  provider: 'synthetic',
  model: 'still-namer',
  observe: async (jpeg: Buffer) => ({
    objects: [
      {
        label: createHash('sha256').update(jpeg).digest('hex').slice(0, 12),
        confidence: 0.5,
        origin: 'proposed',
        box: { x0: 0.1, y0: 0.1, x1: 0.4, y1: 0.4 },
        contour: [
          { x: 0.1, y: 0.1 },
          { x: 0.4, y: 0.1 },
          { x: 0.2, y: 0.4 },
        ],
      },
      {
        label: 'window',
        confidence: 0.5,
        origin: 'base',
        box: { x0: 0.5, y0: 0.5, x1: 0.8, y1: 0.8 },
        contour: [
          { x: 0.5, y: 0.5 },
          { x: 0.8, y: 0.5 },
          { x: 0.6, y: 0.8 },
        ],
      },
    ],
    latencyMs: 1,
  }),
};

/** The words a synthetic term snapshot would let Boopy teach. */
const TEACHABLE = {
  words: ['Desert photo', 'tent'],
  labels: ['Desert photo', 'tent'],
  snapshotSha256: 'a'.repeat(64),
};

async function setup(outline: boolean | typeof namingScene = false, teachable?: typeof TEACHABLE) {
  const data = await mkdtemp(join(directory, 'data-'));
  await writeFile(join(data, 'connector-token'), TOKEN, { mode: 0o600 });
  const interpreter = new CapturingInterpreter();
  const test = testBoopy({ interpreter });
  const scenes = new RecordedScenes({
    journal: test.journal,
    media: test.deps.media,
    directory: join(data, 'recorded'),
    helper,
    ...(outline
      ? { outliner: { scene: outline === true ? namingScene : outline, interpreter } }
      : {}),
  });
  const boopy = new Boopy({ ...test.deps, recorded: scenes, ...(teachable ? { teachable } : {}) });
  const preparation = new HandoffPreparation({
    journal: test.journal,
    outputRoot: join(data, 'handoffs'),
    dataDir: data,
    port: 0,
    packageForId: (id) => boopy.package(id),
    sessionForId: (id) => boopy.view(id),
    supersessions: () => boopy.supersessions,
  });
  const headset = headsetApp(boopy, {
    logger: false,
    recorded: scenes,
    tasks: new TaskStore(test.journal),
  });
  const connector = connectorApp(boopy, {
    token: TOKEN,
    baseUrl: 'https://fictional.example',
    logger: false,
    handoff: preparation,
    recorded: scenes,
  });
  const sha256 = createHash('sha256')
    .update(await readFile(clip))
    .digest('hex');
  await copyFile(clip, join(data, 'recorded', `${sha256}.mov`));
  await chmod(join(data, 'recorded', `${sha256}.mov`), 0o600);
  const local = (
    method: 'GET' | 'POST',
    url: string,
    payload?: unknown,
    headers: Record<string, string> = {},
  ) =>
    connector.inject({
      method,
      url,
      remoteAddress: '127.0.0.1',
      headers: { ...HOST, authorization: `Bearer ${TOKEN}`, ...headers },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  return { ...test, interpreter, scenes, boopy, headset, connector, local, sha256, data };
}

/** Imports the clip twice (two recordings) through the operator route, and shows the first. */
async function shown(teachable?: typeof TEACHABLE) {
  const parts = await setup(false, teachable);
  const one = await parts.local('POST', '/v1/local-recorded/imports', {
    sha256: parts.sha256,
    extension: 'mov',
    sampling: { mode: 'stills', count: 4 },
  });
  assert.equal(one.statusCode, 200, one.body);
  const two = await parts.local('POST', '/v1/local-recorded/imports', {
    sha256: parts.sha256,
    extension: 'mov',
    sampling: { mode: 'stills', count: 2 },
  });
  const show = await parts.local('POST', '/v1/local-recorded/scene', {
    recordingId: one.json().recordingId,
  });
  assert.equal(show.statusCode, 200, show.body);
  const scene = (
    await parts.headset.inject({ method: 'GET', url: '/v1/recorded-scene', headers: HOST })
  ).json().scene;
  return {
    ...parts,
    scene,
    first: one.json().recordingId as string,
    second: two.json().recordingId as string,
  };
}

const boop = (
  scene: { recordingId: string; frames: readonly { frameId: string }[] },
  index = 2,
) => ({
  recordedFrame: { recordingId: scene.recordingId, frameId: scene.frames[index]?.frameId },
  attention: {
    scope: 'target',
    evidence: 'visual',
    source: 'past-recollection',
    ambiguousTarget: false,
    ocrRequested: true,
    segmentationRequested: false,
    maxAgeMs: 15000,
  },
  cues: { gaze: { point: { x: 0.4, y: 0.6 }, onSurface: false } },
  speech: { text: 'What is this?' },
  device: { model: 'Meta Quest 3', app: 'boopy-quest test' },
});

describe('recorded scene routes', () => {
  it('exist only when a recorded store is given', async () => {
    const plain = headsetApp(testBoopy().boopy, { logger: false });
    const answer = await plain.inject({ method: 'GET', url: '/v1/recorded-scene', headers: HOST });
    assert.equal(answer.statusCode, 404);
    const frames = [{ frameId: `rfr_${'0'.repeat(32)}` }];
    const turn = await plain.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: HOST,
      payload: boop({ recordingId: `rec_${'0'.repeat(32)}`, frames }, 0),
    });
    assert.equal(turn.statusCode, 404);
    assert.equal(turn.json().error.code, 'recorded_unavailable');
  });

  it('show no scene, then the shown recording and any of its frames, never cached or shared', async (context) => {
    if (missing) return context.skip(missing);
    const { headset, local, sha256, scenes } = await setup();
    const empty = await headset.inject({ method: 'GET', url: '/v1/recorded-scene', headers: HOST });
    assert.equal(empty.statusCode, 200);
    assert.deepEqual(empty.json(), { scene: null });
    const imported = await local('POST', '/v1/local-recorded/imports', {
      sha256,
      extension: 'mov',
      sampling: { mode: 'stills', count: 4 },
    });
    assert.equal(imported.statusCode, 200, imported.body);
    assert.deepEqual(Object.keys(imported.json()).sort(), [
      'captureTime',
      'display',
      'durationSeconds',
      'frames',
      'height',
      'kind',
      'outlines',
      'projection',
      'recordingId',
      'reused',
      'video',
      'width',
    ]);
    await local('POST', '/v1/local-recorded/scene', { recordingId: imported.json().recordingId });
    const answer = await headset.inject({
      method: 'GET',
      url: '/v1/recorded-scene',
      headers: HOST,
    });
    assert.equal(answer.headers['cache-control'], 'no-store');
    assert.equal(answer.headers['access-control-allow-origin'], undefined);
    assert.deepEqual(answer.json(), { scene: scenes.scene() });
    const frame = answer.json().scene.frames[3];
    const jpeg = await headset.inject({
      method: 'GET',
      url: `/v1/recorded-scene/frames/${frame.frameId}`,
      headers: HOST,
    });
    assert.equal(jpeg.statusCode, 200);
    assert.equal(jpeg.headers['content-type'], 'image/jpeg');
    assert.equal(jpeg.headers['cache-control'], 'no-store');
    assert.equal(createHash('sha256').update(jpeg.rawPayload).digest('hex'), frame.frameSha256);
    const unknown = await headset.inject({
      method: 'GET',
      url: `/v1/recorded-scene/frames/rfr_${'0'.repeat(32)}`,
      headers: HOST,
    });
    assert.equal(unknown.statusCode, 404);
    assert.equal(unknown.json().error.code, 'recorded_frame_unknown');
  });

  it('refuse a browser page, which could otherwise load the footage', async (context) => {
    if (missing) return context.skip(missing);
    const { headset, scene } = await shown();
    for (const headers of [
      { origin: 'http://127.0.0.1:47900' },
      { 'sec-fetch-site': 'cross-site' },
      { 'sec-fetch-site': 'same-origin' },
    ])
      for (const url of ['/v1/recorded-scene', `/v1/recorded-scene/frames/${scene.frameId}`]) {
        const answer = await headset.inject({
          method: 'GET',
          url,
          headers: { ...HOST, ...headers },
        });
        assert.equal(answer.statusCode, 403, `${url} ${JSON.stringify(headers)}`);
        assert.equal(answer.json().error.code, 'browser_not_allowed');
      }
    const direct = await headset.inject({
      method: 'GET',
      url: '/v1/recorded-scene',
      headers: { ...HOST, 'sec-fetch-site': 'none' },
    });
    assert.equal(direct.statusCode, 200);
  });

  it('take imports, shows and clears only from the local operator with the token', async (context) => {
    if (missing) return context.skip(missing);
    const { connector, local, sha256 } = await setup();
    const body = { sha256, extension: 'mov', sampling: { mode: 'stills', count: 1 } };
    const bare = await connector.inject({
      method: 'POST',
      url: '/v1/local-recorded/imports',
      remoteAddress: '127.0.0.1',
      headers: HOST,
      payload: body,
    });
    assert.equal(bare.statusCode, 401);
    const browser = await local('POST', '/v1/local-recorded/imports', body, {
      origin: 'http://127.0.0.1',
    });
    assert.equal(browser.statusCode, 403);
    const imported = await local('POST', '/v1/local-recorded/imports', body);
    assert.equal(imported.statusCode, 200, imported.body);
    const list = await local('GET', '/v1/local-recorded/recordings');
    assert.deepEqual(
      list.json().recordings.map((entry: { recordingId: string }) => entry.recordingId),
      [imported.json().recordingId],
    );
    const nothing = await local('POST', '/v1/local-recorded/scene/clear', {});
    assert.equal(nothing.statusCode, 409);
    assert.equal(nothing.json().error.code, 'recorded_scene_none');
    const show = await local('POST', '/v1/local-recorded/scene', {
      recordingId: imported.json().recordingId,
    });
    assert.equal(show.json().scene.recordingId, imported.json().recordingId);
    const cleared = await local('POST', '/v1/local-recorded/scene/clear', {});
    assert.deepEqual(cleared.json(), { scene: null });
    const missingFile = await local('POST', '/v1/local-recorded/imports', {
      ...body,
      sha256: 'd'.repeat(64),
    });
    assert.equal(missingFile.statusCode, 404);
    assert.equal(missingFile.json().error.code, 'recorded_source_missing');
  });
});

describe('outlines for a recording', () => {
  it('come back on the very frames they were made from', async (context) => {
    if (missing) return context.skip(missing);
    const { headset, local, sha256, scenes, interpreter } = await setup(true);
    const imported = await local('POST', '/v1/local-recorded/imports', {
      sha256,
      extension: 'mov',
      sampling: { mode: 'stills', count: 4 },
    });
    const recordingId = imported.json().recordingId;
    await local('POST', '/v1/local-recorded/scene', { recordingId });
    const started = await local('POST', '/v1/local-recorded/outlines', { recordingId });
    assert.equal(started.statusCode, 202, started.body);
    while (scenes.recordings()[0]?.outlines.running)
      await new Promise((done) => setTimeout(done, 10));
    assert.equal(interpreter.inputs.length, 1, 'nouns are proposed once per recording');
    const scene = scenes.scene();
    const answer = await headset.inject({
      method: 'GET',
      url: '/v1/recorded-scene/outlines',
      headers: HOST,
    });
    const samples = answer.json().samples;
    assert.deepEqual(
      samples.map((sample: { frameId: string; objects: { label: string }[] }) => [
        sample.frameId,
        sample.objects[0]?.label,
      ]),
      scene?.frames.map((frame) => [frame.frameId, frame.frameSha256.slice(0, 12)]),
    );
    assert.ok(
      samples.every((sample: { verification: string }) => sample.verification === 'proposed'),
    );
    // Only nouns the interpreter proposed for this recording are served; the general list's are not.
    assert.ok(samples.every((sample: { objects: unknown[] }) => sample.objects.length === 1));
    assert.deepEqual(scenes.recordings()[0]?.outlines, { running: false, frames: 4 });
  });
});

describe('playback of a recorded clip', () => {
  it('serves the shown clip as captured, by range, with no tag, and with its lens field of view', async (context) => {
    if (missing) return context.skip(missing);
    // Planted only to prove they never come out of the served video.
    const tagged = join(directory, 'tagged.mov');
    const made = spawnSync(FFMPEG, [
      ...['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10'],
      ...['-f', 'lavfi', '-i', 'sine', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p'],
      ...['-c:a', 'aac', '-movflags', 'use_metadata_tags'],
      ...['-metadata', 'com.apple.quicktime.camera.focal_length.35mm_equivalent=26'],
      ...['-metadata', 'com.apple.quicktime.location.ISO6709=+12.3456-065.4321/', tagged],
    ]);
    assert.equal(made.status, 0, made.stderr?.toString().slice(0, 400));
    const { headset, local, scenes, data } = await setup();
    const sha256 = createHash('sha256')
      .update(await readFile(tagged))
      .digest('hex');
    await copyFile(tagged, join(data, 'recorded', `${sha256}.mov`));
    const imported = await local('POST', '/v1/local-recorded/imports', {
      sha256,
      extension: 'mov',
      sampling: { mode: 'stills', count: 4 },
    });
    assert.equal(imported.json().video, true);
    await local('POST', '/v1/local-recorded/scene', { recordingId: imported.json().recordingId });
    const scene = scenes.scene();
    assert.ok(scene?.video);
    const whole = await headset.inject({ method: 'GET', url: scene.video.url, headers: HOST });
    assert.equal(whole.statusCode, 200);
    assert.equal(whole.headers['content-type'], 'video/mp4');
    assert.equal(createHash('sha256').update(whole.rawPayload).digest('hex'), scene.video.sha256);
    const text = whole.rawPayload.toString('latin1');
    for (const planted of ['12.3456', '065.4321', 'ISO6709', 'focal_length', 'quicktime'])
      assert.equal(text.includes(planted), false, planted);
    const part = await headset.inject({
      method: 'GET',
      url: scene.video.url,
      headers: { ...HOST, range: 'bytes=0-99' },
    });
    assert.equal(part.statusCode, 206);
    assert.equal(part.headers['content-range'], `bytes 0-99/${whole.rawPayload.length}`);
    assert.deepEqual(part.rawPayload, whole.rawPayload.subarray(0, 100));
    // Every kept frame's time is a frame time in the served video, which has no audio.
    const served = join(directory, 'served.mp4');
    await writeFile(served, whole.rawPayload);
    const probe = spawnSync('/opt/homebrew/bin/ffprobe', [
      ...[
        '-v',
        'error',
        '-show_entries',
        'stream=codec_type:frame=pts_time',
        '-of',
        'json',
        served,
      ],
    ]);
    const info = JSON.parse(probe.stdout.toString()) as {
      streams: { codec_type: string }[];
      frames: { pts_time: string }[];
    };
    assert.deepEqual(
      info.streams.map((stream) => stream.codec_type),
      ['video'],
    );
    const times = info.frames.map((frame) => Number(frame.pts_time));
    for (const frame of scene.frames)
      assert.ok(
        times.some((time) => Math.abs(time - (frame.seconds ?? -1)) < 0.001),
        `frame at ${frame.seconds}`,
      );
    assert.ok((scene.video.frameRate ?? 0) > 3 && (scene.video.frameRate ?? 0) <= 10);
    // The lens tag gives a centred projection; a measured device profile replaces it.
    assert.deepEqual(scene.projection, {
      ...lensProjection(26, 320, 240),
      source: 'lens-tag',
      profile: null,
      centring: 'assumed',
    });
    // 26 mm equivalent on a 4:3 picture is about 67 degrees across.
    const across = (2 * Math.atan(scene.projection?.tanLeft ?? 0) * 180) / Math.PI;
    assert.ok(across > 60 && across < 75, String(across));
    const measured = await local('POST', '/v1/local-recorded/projection', {
      recordingId: scene.recordingId,
      tanLeft: 0.8424,
      tanRight: 0.8359,
      tanUp: 0.472,
      tanDown: 0.472,
      profile: 'synthetic-capture',
      centring: 'inferred',
      reference: {
        profile: 'synthetic-square',
        tanLeft: 0.8424,
        tanRight: 0.8359,
        tanUp: 0.7334,
        tanDown: 0.9449,
      },
    });
    assert.equal(measured.json().projection, 'measured-device-profile');
    assert.deepEqual(scenes.scene()?.projection, {
      tanLeft: 0.8424,
      tanRight: 0.8359,
      tanUp: 0.472,
      tanDown: 0.472,
      source: 'measured-device-profile',
      profile: 'synthetic-capture',
      centring: 'inferred',
    });
  });
});

describe('the booped subject on a recorded frame', () => {
  it("takes the shape of the frame's own outline over its box, and keeps the box without one", async (context) => {
    if (missing) return context.skip(missing);
    // The outline pass places one shape wherever the test says, named as the interpreter's noun.
    let shape = { x0: 0.1, y0: 0.1, x1: 0.2, y1: 0.2 };
    const scene = {
      provider: 'local',
      model: 'synthetic-outliner',
      observe: async () => ({
        objects: [
          {
            label: 'camel',
            confidence: 0.6,
            origin: 'proposed',
            box: shape,
            contour: [
              { x: shape.x0, y: shape.y1 },
              { x: (shape.x0 + shape.x1) / 2, y: shape.y0 },
              { x: shape.x1, y: shape.y1 },
            ],
          },
        ],
        latencyMs: 3,
      }),
    };
    const { headset, local, sha256, scenes } = await setup(scene);
    const imported = await local('POST', '/v1/local-recorded/imports', {
      sha256,
      extension: 'mov',
      sampling: { mode: 'stills', count: 2 },
    });
    const recordingId = imported.json().recordingId;
    await local('POST', '/v1/local-recorded/scene', { recordingId });
    const shown = scenes.scene();
    assert.ok(shown !== null);
    const camels = (view: {
      items: {
        label: string;
        grounding: { box?: typeof shape; contour?: unknown[]; spatial?: Record<string, unknown> };
      }[];
    }) => view.items.find((item) => item.label === 'Camels');
    // Without an outline run the frame's items keep their boxes.
    const before = (
      await headset.inject({
        method: 'POST',
        url: '/v1/sessions',
        headers: HOST,
        payload: boop(shown, 1),
      })
    ).json();
    assert.equal(camels(before)?.grounding.contour, undefined);
    shape = camels(before)?.grounding.box ?? shape;
    await local('POST', '/v1/local-recorded/outlines', { recordingId });
    while (scenes.recordings()[0]?.outlines.running)
      await new Promise((done) => setTimeout(done, 10));
    const after = (
      await headset.inject({
        method: 'POST',
        url: '/v1/sessions',
        headers: HOST,
        payload: boop(shown, 1),
      })
    ).json();
    const subject = camels(after);
    assert.equal(subject?.grounding.contour?.length, 3);
    assert.equal(subject?.grounding.box?.x0, shape.x0, 'the box is kept beside the shape');
    assert.equal(subject?.label, 'Camels', 'the item keeps its own label');
    assert.deepEqual(
      {
        ...subject?.grounding.spatial,
        latencyMs: undefined,
        frameSha256: undefined,
        utteranceId: undefined,
      },
      {
        provider: 'local',
        model: 'synthetic-outliner',
        concept: 'camel',
        latencyMs: undefined,
        confidence: 0.6,
        verification: 'proposed',
        outcome: 'contour',
        frameSha256: undefined,
        utteranceId: undefined,
        from: 'recorded-outline',
        overlap: 1,
      },
    );
    // The large photo item overlaps the small camel shape by far less than half: it keeps its box.
    const photo = after.items.find((item: { label: string }) => item.label === 'Desert photo');
    assert.equal(photo?.grounding.contour, undefined);
  });
});

describe('a turn on a recorded frame', () => {
  it('journals a recorded observation and runs the same turn as a capture', async (context) => {
    if (missing) return context.skip(missing);
    const { headset, journal, interpreter, scene } = await shown();
    const answer = await headset.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: HOST,
      payload: boop(scene),
    });
    assert.equal(answer.statusCode, 200, answer.body);
    const view = answer.json();
    assert.deepEqual(view.observations[0], {
      id: view.observations[0].id,
      capturedAt: null,
      recorded: {
        recordingId: scene.recordingId,
        frameId: scene.frames[2].frameId,
        seconds: scene.frames[2].seconds,
      },
    });
    const observed = journal.all().find((event) => event.type === 'observation.recorded');
    assert.ok(observed?.type === 'observation.recorded');
    assert.equal(observed.data.source, 'past-recollection');
    assert.equal(observed.data.timestampTrusted, false);
    assert.equal(observed.data.camera, null);
    assert.equal(observed.data.depth, null);
    assert.equal(observed.data.capturedAt, null);
    assert.equal(observed.data.frameSha256, scene.frames[2].frameSha256);
    assert.deepEqual(observed.data.recorded, {
      recordingId: scene.recordingId,
      frameId: scene.frames[2].frameId,
      sourceSha256: observed.data.recorded?.sourceSha256,
      seconds: scene.frames[2].seconds,
    });
    const attention = journal.all().find((event) => event.type === 'attention.decided');
    assert.ok(attention?.type === 'attention.decided');
    assert.equal(attention.data.action, 'reuse');
    for (const word of NOT_ABOUT_A_RECORDING)
      assert.equal(attention.data.reason.toLowerCase().includes(word), false, word);
    const input = interpreter.inputs[0];
    assert.equal(input?.sourceContext?.source, 'past-recollection');
    assert.deepEqual(input?.sourceContext?.recorded, { seconds: scene.frames[2].seconds });
    // The model sees the view around the gaze; mapped back through the journaled region, its gaze
    // is the boop's point on the frame.
    assert.equal(input?.view, 'gaze-crop');
    const proposed = journal.all().find((event) => event.type === 'interpretation.proposed');
    assert.ok(proposed?.type === 'interpretation.proposed' && proposed.data.view && input?.gaze);
    const region = proposed.data.view.region;
    const back = {
      x: region.x0 + input.gaze.x * (region.x1 - region.x0),
      y: region.y0 + input.gaze.y * (region.y1 - region.y0),
    };
    assert.ok(Math.abs(back.x - 0.4) < 1e-9 && Math.abs(back.y - 0.6) < 1e-9);
    for (const word of NOT_ABOUT_A_RECORDING)
      assert.equal(input?.sourceContext?.selectionReason.toLowerCase().includes(word), false, word);
    assert.equal(JSON.stringify(journal.all()).includes('current-surroundings'), false);
  });

  it('takes a tap, or a held boop with no words, as a boop by pointing', async (context) => {
    if (missing) return context.skip(missing);
    const { headset, journal, interpreter, scene } = await shown();
    const post = (payload: unknown) =>
      headset.inject({
        method: 'POST',
        url: '/v1/sessions',
        headers: HOST,
        payload: payload as object,
      });
    const asked = await post(boop(scene));
    assert.equal(asked.statusCode, 200, asked.body);
    const tapped = await post({ ...boop(scene), speech: { gesture: 'tap' } });
    assert.equal(tapped.statusCode, 200, tapped.body);
    // The synthetic recognizer hears no words in this clip.
    const held = await post({
      ...boop(scene),
      speech: { wav: Buffer.from('RIFF').toString('base64') },
    });
    assert.equal(held.statusCode, 200, held.body);
    const heard = journal
      .all()
      .flatMap((event) =>
        event.type === 'utterance.heard' ? [[event.data.source, event.data.text]] : [],
      );
    assert.deepEqual(heard, [
      ['typed', 'What is this?'],
      ['pointing', ''],
      ['speech', ''],
    ]);
    // Boopy is asked exactly what a spoken "What is this?" asks, about the same point.
    const [ask, tap, hold] = interpreter.inputs;
    for (const input of [tap, hold]) {
      assert.equal(input?.said, ask?.said);
      assert.deepEqual(input?.gaze, ask?.gaze);
    }
    assert.equal(tapped.json().items.length > 0, true);
    // A tap is a boop on a recorded frame only; in the room it is refused.
    const room = await post({ ...startRequest('x'), speech: { gesture: 'tap' } });
    assert.equal(room.statusCode, 400, room.body);
  });

  // A model may answer a wordless boop with the whole scene, as one did on the camp's tents.
  const aboutTheScene =
    (boxes?: number[]) =>
    (output: ModelOutput): ModelOutput => ({
      ...output,
      scope: 'scene',
      referent: { key: null, basis: 'scene', alternatives: [] },
      response: 'A wide desert camp at dusk, with a person walking past a row of huts.',
      items: output.items.map((item) => (boxes === undefined ? item : { ...item, box: boxes })),
    });

  it('a tap that the model answers with the whole scene asks about the object at the point', async (context) => {
    if (missing) return context.skip(missing);
    const { headset, journal, interpreter, scene } = await shown();
    interpreter.change = aboutTheScene();
    const tapped = await headset.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: HOST,
      payload: { ...boop(scene), speech: { gesture: 'tap' } },
    });
    assert.equal(tapped.statusCode, 200, tapped.body);
    const view = tapped.json();
    const referent = view.items.find((item: { id: string }) => item.id === view.referentId);
    // The fixture's photo box holds the gaze point; its camels box is the smaller one beside it.
    assert.equal(referent?.label, 'Desert photo');
    assert.equal(referent?.status, 'proposed');
    assert.equal(referent?.confidence, 0.85);
    assert.equal(view.dialogue?.text, 'Desert photo, I think.');
    const proposed = journal.all().find((event) => event.type === 'interpretation.proposed');
    assert.ok(proposed?.type === 'interpretation.proposed');
    assert.equal(proposed.data.referentId, referent.id);
    assert.deepEqual(proposed.data.referentPoint, { cue: 'gaze', from: 'model-object' });
    // The model's own scene answer is kept for audit, never shown as the reply.
    assert.match(proposed.data.raw, /wide desert camp/);
    const task = await headset.inject({
      method: 'POST',
      url: `/v1/sessions/${view.id}/task`,
      headers: { ...HOST, 'content-type': 'application/json' },
      payload: { eventId: 'evt_tap_open', taskId: 'tsk_tap' },
    });
    assert.equal(task.statusCode, 200, task.body);
    assert.equal(task.json().utterance, '');
    assert.equal(
      task.json().components.find((part: { type: string }) => part.type === 'annotation')?.text,
      'Desert photo',
    );
  });

  it('a spoken What is this? follows the point too, while a question about the place does not', async (context) => {
    if (missing) return context.skip(missing);
    const { headset, interpreter, scene } = await shown();
    interpreter.change = aboutTheScene();
    const post = (said: string) =>
      headset.inject({
        method: 'POST',
        url: '/v1/sessions',
        headers: HOST,
        payload: { ...boop(scene), speech: { text: said } },
      });
    const asked = (await post('What is this?')).json();
    assert.equal(
      asked.items.find((item: { id: string }) => item.id === asked.referentId)?.label,
      'Desert photo',
    );
    assert.equal(asked.dialogue?.text, 'Desert photo, I think.');
    const place = (await post('What is this place?')).json();
    assert.equal(
      place.dialogue?.text,
      'A wide desert camp at dusk, with a person walking past a row of huts.',
    );
  });

  it('a pointing boop says only the guess, also when the model named the subject, and is told the words Boopy can teach', async (context) => {
    if (missing) return context.skip(missing);
    const { headset, journal, interpreter, scene } = await shown(TEACHABLE);
    // The fixture names its photo at the gaze itself, with a long reply of its own.
    const tapped = await headset.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: HOST,
      payload: { ...boop(scene), speech: { gesture: 'tap' } },
    });
    assert.equal(tapped.statusCode, 200, tapped.body);
    assert.equal(tapped.json().dialogue?.text, 'Desert photo, I think.');
    const proposed = journal.all().find((event) => event.type === 'interpretation.proposed');
    assert.ok(proposed?.type === 'interpretation.proposed');
    assert.equal(proposed.data.referentPoint, undefined);
    assert.deepEqual(proposed.data.hint, {
      kind: 'teachable-words',
      count: 2,
      snapshotSha256: TEACHABLE.snapshotSha256,
    });
    assert.deepEqual(interpreter.inputs.at(-1)?.teachable, TEACHABLE.words);
    // A question about the place gets no hint and keeps the model's own answer.
    const place = await headset.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: HOST,
      payload: { ...boop(scene), speech: { text: 'What is this place?' } },
    });
    assert.equal(place.statusCode, 200, place.body);
    assert.equal(interpreter.inputs.at(-1)?.teachable, undefined);
    assert.notEqual(place.json().dialogue?.text, 'Desert photo, I think.');
    const placed = journal
      .all()
      .filter((event) => event.type === 'interpretation.proposed')
      .at(-1);
    assert.ok(placed?.type === 'interpretation.proposed');
    assert.equal(placed.data.hint, undefined);
  });

  it('a plural or a modified label is shown and picked as the word Boopy can teach, and kept in raw', async (context) => {
    if (missing) return context.skip(missing);
    const { headset, journal, interpreter, scene } = await shown(TEACHABLE);
    interpreter.change = (output) => ({
      ...output,
      items: output.items.map((item) =>
        item.key === 'photo' ? { ...item, label: 'Tents' } : item,
      ),
    });
    const tapped = await headset.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: HOST,
      payload: { ...boop(scene), speech: { gesture: 'tap' } },
    });
    assert.equal(tapped.statusCode, 200, tapped.body);
    const view = tapped.json();
    assert.equal(view.dialogue?.text, 'Tent, I think.');
    const proposed = journal.all().find((event) => event.type === 'interpretation.proposed');
    assert.ok(proposed?.type === 'interpretation.proposed');
    assert.match(proposed.data.raw, /"label":"Tents"/);
    const task = await headset.inject({
      method: 'POST',
      url: `/v1/sessions/${view.id}/task`,
      headers: { ...HOST, 'content-type': 'application/json' },
      payload: { eventId: 'evt_tents_open', taskId: 'tsk_tents' },
    });
    assert.equal(task.statusCode, 200, task.body);
    // The annotation is the guess the term pick folds into its match key.
    assert.equal(
      task.json().components.find((part: { type: string }) => part.type === 'annotation')?.text,
      'Tent',
    );
    // A modifier in front finds the same word.
    interpreter.change = (output) => ({
      ...output,
      items: output.items.map((item) =>
        item.key === 'photo' ? { ...item, label: 'desert tent' } : item,
      ),
    });
    const modified = await headset.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: HOST,
      payload: { ...boop(scene), speech: { gesture: 'tap' } },
    });
    assert.equal(modified.json().dialogue?.text, 'Tent, I think.');
  });

  it("a tap the model placed nothing at takes the recording's own outline there", async (context) => {
    if (missing) return context.skip(missing);
    // A local outline pass that places one camel, named as the interpreter's noun.
    const box = { x0: 0.1, y0: 0.1, x1: 0.3, y1: 0.3 };
    const { headset, local, sha256, scenes, interpreter, journal } = await setup({
      provider: 'local',
      model: 'synthetic-outliner',
      observe: async () => ({
        objects: [
          {
            label: 'camel',
            confidence: 0.6,
            origin: 'proposed',
            box,
            contour: [
              { x: box.x0, y: box.y1 },
              { x: (box.x0 + box.x1) / 2, y: box.y0 },
              { x: box.x1, y: box.y1 },
            ],
          },
        ],
        latencyMs: 3,
      }),
    });
    const imported = await local('POST', '/v1/local-recorded/imports', {
      sha256,
      extension: 'mov',
      sampling: { mode: 'stills', count: 4 },
    });
    const recordingId = imported.json().recordingId;
    await local('POST', '/v1/local-recorded/scene', { recordingId });
    await local('POST', '/v1/local-recorded/outlines', { recordingId });
    while (scenes.recordings()[0]?.outlines.running)
      await new Promise((done) => setTimeout(done, 10));
    const scene = scenes.scene();
    assert.ok(scene);
    interpreter.change = aboutTheScene([0, 0, 40, 40]);
    const at = boop(scene);
    const tapped = await headset.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: HOST,
      payload: {
        ...at,
        cues: { gaze: { point: { x: 0.2, y: 0.25 }, onSurface: false } },
        speech: { gesture: 'tap' },
      },
    });
    assert.equal(tapped.statusCode, 200, tapped.body);
    const view = tapped.json();
    const referent = view.items.find((item: { id: string }) => item.id === view.referentId);
    assert.equal(referent?.label, 'camel');
    assert.equal(referent?.confidence, 0.6);
    assert.equal(referent?.origin, 'model');
    assert.equal(referent?.status, 'proposed');
    assert.equal(referent?.grounding.spatial.from, 'recorded-outline');
    assert.equal(view.dialogue?.text, 'Camel, I think.');
    const proposed = journal.all().find((event) => event.type === 'interpretation.proposed');
    assert.ok(proposed?.type === 'interpretation.proposed');
    assert.deepEqual(proposed.data.referentPoint, { cue: 'gaze', from: 'recorded-outline' });
  });

  it('a tap on nothing the model or the outlines placed gets one short honest line', async (context) => {
    if (missing) return context.skip(missing);
    const { headset, interpreter, scene } = await shown();
    // Every box in the far corner of the view, away from the gaze point.
    interpreter.change = aboutTheScene([0, 0, 40, 40]);
    const tapped = await headset.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: HOST,
      payload: { ...boop(scene), speech: { gesture: 'tap' } },
    });
    assert.equal(tapped.statusCode, 200, tapped.body);
    const view = tapped.json();
    assert.equal(view.referentId, null);
    assert.equal(view.dialogue?.text, "I'm not sure what that is.");
    // A later tap in a session whose first turn had a subject is still about its own point.
    interpreter.change = null;
    const asked = await headset.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: HOST,
      payload: boop(scene),
    });
    assert.ok(asked.json().referentId);
    interpreter.change = aboutTheScene([0, 0, 40, 40]);
    const later = await headset.inject({
      method: 'POST',
      url: `/v1/sessions/${asked.json().id}/utterances`,
      headers: HOST,
      payload: {
        recordedFrame: boop(scene).recordedFrame,
        attention: boop(scene).attention,
        cues: boop(scene).cues,
        speech: { gesture: 'tap' },
      },
    });
    assert.equal(later.statusCode, 200, later.body);
    assert.equal(later.json().referentId, null);
    assert.equal(later.json().dialogue?.text, "I'm not sure what that is.");
    const task = await headset.inject({
      method: 'POST',
      url: `/v1/sessions/${view.id}/task`,
      headers: { ...HOST, 'content-type': 'application/json' },
      payload: { eventId: 'evt_tap_open', taskId: 'tsk_tap' },
    });
    assert.equal(task.statusCode, 409, task.body);
  });

  it('refuses a recorded frame mixed with a room frame, a pointer, a surface or another source', async (context) => {
    if (missing) return context.skip(missing);
    const { headset, scene, journal } = await shown();
    const base = boop(scene);
    for (const change of [
      { frame: startRequest('x').frame },
      {
        cues: {
          ...base.cues,
          pointer: { point: { x: 0.5, y: 0.5 }, onSurface: false, hand: 'right' },
        },
      },
      { cues: { gaze: { point: { x: 0.5, y: 0.5 }, onSurface: true } } },
      { cues: { gaze: { point: { x: 0.5, y: 0.5 }, onSurface: false, world: [0, 0, 1] } } },
      { attention: { ...base.attention, source: 'current-surroundings' } },
      { attention: { ...base.attention, evidence: 'none' } },
    ]) {
      const answer = await headset.inject({
        method: 'POST',
        url: '/v1/sessions',
        headers: HOST,
        payload: { ...base, ...change },
      });
      assert.equal(answer.statusCode, 400, JSON.stringify(change));
    }
    assert.equal(journal.all().filter((event) => event.type === 'session.started').length, 0);
  });

  it('refuses a frame from a scene that changed, before any session starts', async (context) => {
    if (missing) return context.skip(missing);
    const { headset, local, scene, second, journal } = await shown();
    await local('POST', '/v1/local-recorded/scene', { recordingId: second });
    const answer = await headset.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: HOST,
      payload: boop(scene),
    });
    assert.equal(answer.statusCode, 409);
    assert.equal(answer.json().error.code, 'recorded_frame_changed');
    const unknown = await headset.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: HOST,
      payload: {
        ...boop(scene),
        recordedFrame: { recordingId: second, frameId: `rfr_${'0'.repeat(32)}` },
      },
    });
    assert.equal(unknown.statusCode, 404);
    assert.equal(unknown.json().error.code, 'recorded_frame_unknown');
    assert.equal(journal.all().filter((event) => event.type === 'session.started').length, 0);
  });

  it('keeps a recorded-scene service to recorded frames, so its data folder stays recorded only', async (context) => {
    if (missing) return context.skip(missing);
    const { headset, scene, journal } = await shown();
    const started = await headset.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: HOST,
      payload: boop(scene),
    });
    const id = started.json().id;
    const { device: _device, ...followUp } = boop(scene, 3);
    const again = await headset.inject({
      method: 'POST',
      url: `/v1/sessions/${id}/utterances`,
      headers: HOST,
      payload: followUp,
    });
    assert.equal(again.statusCode, 200, again.body);
    assert.equal(again.json().observations[1].recorded.frameId, scene.frames[3].frameId);
    const room = startRequest('What is this?');
    for (const [url, payload] of [
      ['/v1/sessions', room],
      [`/v1/sessions/${id}/utterances`, { frame: room.frame, speech: { text: 'And this?' } }],
    ] as const) {
      const live = await headset.inject({ method: 'POST', url, headers: HOST, payload });
      assert.equal(live.statusCode, 409, url);
      assert.equal(live.json().error.code, 'recorded_only');
    }
    const observed = journal.all().filter((event) => event.type === 'observation.recorded');
    assert.equal(observed.length, 2);
    assert.ok(
      observed.every(
        (event) => event.type === 'observation.recorded' && event.data.recorded !== undefined,
      ),
    );
    assert.equal(journal.all().filter((event) => event.type === 'session.started').length, 1);
  });

  it('opens the session task on the recorded still, never as the surroundings', async (context) => {
    if (missing) return context.skip(missing);
    const { headset, scene } = await shown();
    const started = await headset.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: HOST,
      payload: boop(scene),
    });
    const task = await headset.inject({
      method: 'POST',
      url: `/v1/sessions/${started.json().id}/task`,
      headers: { ...HOST, 'content-type': 'application/json' },
      payload: { eventId: 'evt_recorded_task', taskId: 'tsk_recorded' },
    });
    assert.equal(task.statusCode, 200, task.body);
    assert.equal(task.json().source.sha256, scene.frames[2].frameSha256);
    assert.equal(task.body.includes('current-surroundings'), false);
    assert.equal(task.json().delivery, 'not-sent');
  });

  it('labels the recorded observation in saved context, with its capture time unknown', async (context) => {
    if (missing) return context.skip(missing);
    const { headset, scene, boopy } = await shown();
    const started = await headset.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: HOST,
      payload: boop(scene),
    });
    const committed = boopy.commit(started.json().id);
    const saved = boopy.package(committed.committed?.packageId ?? '');
    const observation = saved?.provenance.observations[0];
    assert.equal(observation?.capturedAt, null);
    assert.equal(observation?.source, 'past-recollection');
    assert.deepEqual(observation?.recorded, {
      recordingId: scene.recordingId,
      frameId: scene.frames[2].frameId,
      seconds: scene.frames[2].seconds,
    });
  });
});
