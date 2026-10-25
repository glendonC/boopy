import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  copyFile,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { BoopyError } from './boopy.ts';
import { Journal, MediaStore } from './journal.ts';
import { assertNoLiveCaptures, RecordedScenes } from './recorded-source.ts';

// Every clip and photo here is made in this test from solid colors; nothing is personal media.
const FFMPEG = '/opt/homebrew/bin/ffmpeg';
const FFPROBE = '/opt/homebrew/bin/ffprobe';
const PALETTE: readonly (readonly number[])[] = [
  [255, 0, 0],
  [0, 255, 0],
  [0, 0, 255],
  [255, 255, 0],
  [255, 0, 255],
  [0, 255, 255],
  [128, 0, 0],
  [0, 128, 0],
  [0, 0, 128],
  [128, 128, 0],
  [128, 0, 128],
  [0, 128, 128],
];
// Planted only to prove they never come out: no digit run of these may appear anywhere.
const PLANTED_GPS = { latitude: '31/1 7/1 4321/100', longitude: '4/1 1/1 8765/100' };

let directory: string;
let helper: string;
let missing: string | false = false;
const clips: Record<string, string> = {};

function tool(file: string, args: string[], input?: Buffer) {
  const result = spawnSync(file, args, { timeout: 60_000, maxBuffer: 1024 * 1024, input });
  assert.equal(result.status, 0, `${file} failed: ${result.stderr?.toString().slice(0, 400)}`);
  return result;
}

/** 12 frames of 64x48 with a white stripe on the left, shown at 0, 0.1 ... 0.6, then wider gaps. */
function paletteClip(output: string, extra: string[] = []) {
  const frames = PALETTE.map((color) => {
    const frame = Buffer.alloc(64 * 48 * 3);
    for (let y = 0; y < 48; y++)
      for (let x = 0; x < 64; x++) frame.set(x < 8 ? [255, 255, 255] : color, (y * 64 + x) * 3);
    return frame;
  });
  tool(
    FFMPEG,
    [
      ...['-v', 'error', '-y', '-f', 'rawvideo', '-pixel_format', 'rgb24', '-video_size', '64x48'],
      ...['-framerate', '10', '-i', 'pipe:0'],
      ...['-vf', "settb=1/1000,setpts='if(lt(N,7),N*0.1/TB,(0.6+(N-6)*0.2)/TB)',setsar=1"],
      ...['-fps_mode', 'passthrough', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-bf', '2'],
      ...extra,
      output,
    ],
    Buffer.concat(frames),
  );
}

/** The times ffprobe shows for each displayed frame, edit list applied. */
function displayedTimes(file: string): number[] {
  return tool(FFPROBE, [
    ...['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=pts_time'],
    ...['-of', 'csv=p=0', '-i', file],
  ])
    .stdout.toString()
    .trim()
    .split('\n')
    .map((line) => Number(line.replace(/,$/, '')));
}

async function photo(
  output: string,
  exif: Record<string, Record<string, string>>,
  orientation: number,
) {
  const pixels = Buffer.alloc(64 * 48 * 3);
  for (let y = 0; y < 48; y++)
    for (let x = 0; x < 64; x++)
      pixels.set(x < 8 ? [255, 255, 255] : [0, 0, 255], (y * 64 + x) * 3);
  const jpeg = join(directory, 'photo-source.jpg');
  await sharp(pixels, { raw: { width: 64, height: 48, channels: 3 } })
    .withMetadata({ orientation, exif })
    .jpeg()
    .toFile(jpeg);
  tool('/usr/bin/sips', ['-s', 'format', 'heic', jpeg, '--out', output]);
}

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'boopy-recorded-source-'));
  const absent = [FFMPEG, FFPROBE, '/usr/bin/swiftc', '/usr/bin/sips'].filter(
    (file) => spawnSync(file, ['-version'], { timeout: 5000 }).error !== undefined,
  );
  if (absent.length) {
    missing = `Needs ${absent.join(', ')}; recorded import was not proven.`;
    return;
  }
  helper = join(directory, 'boopy-recorded');
  tool('/usr/bin/swiftc', [
    '-O',
    '-o',
    helper,
    fileURLToPath(new URL('../tools/recorded/main.swift', import.meta.url)),
  ]);
  clips.palette = join(directory, 'palette.mov');
  paletteClip(join(directory, 'palette-upright.mov'));
  // A real display matrix, written by a stream copy so the stored pixels stay unturned.
  tool(FFMPEG, [
    ...[
      '-v',
      'error',
      '-y',
      '-display_rotation',
      '90',
      '-i',
      join(directory, 'palette-upright.mov'),
    ],
    ...['-c', 'copy', clips.palette],
  ]);
  clips.dated = join(directory, 'dated.mov');
  paletteClip(clips.dated, [
    ...['-metadata', 'creation_time=2001-02-03T04:05:06.000000Z'],
    ...['-movflags', 'use_metadata_tags'],
    ...['-metadata', 'com.apple.quicktime.creationdate=2001-02-03T05:05:06+0100'],
  ]);
  clips.conflict = join(directory, 'conflict.mov');
  paletteClip(clips.conflict, [
    ...['-metadata', 'creation_time=2001-02-03T04:05:06.000000Z'],
    ...['-movflags', 'use_metadata_tags'],
    ...['-metadata', 'com.apple.quicktime.creationdate=2001-02-03T04:09:06Z'],
  ]);
  clips.hlg = join(directory, 'hlg.mov');
  tool(FFMPEG, [
    ...['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=96x64:rate=10', '-t', '1'],
    ...[
      '-c:v',
      'libx265',
      '-x265-params',
      'log-level=error:colorprim=bt2020:transfer=arib-std-b67',
    ],
    ...['-tag:v', 'hvc1', '-pix_fmt', 'yuv420p', '-color_trc', 'arib-std-b67'],
    ...['-color_primaries', 'bt2020', '-colorspace', 'bt2020nc', '-movflags', '+write_colr'],
    clips.hlg,
  ]);
  clips.long = join(directory, 'long.mov');
  tool(FFMPEG, [
    ...['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=gray:size=16x16:rate=1', '-t', '61'],
    ...['-c:v', 'libx264', '-pix_fmt', 'yuv420p', clips.long],
  ]);
  const gps = {
    GPSLatitudeRef: 'N',
    GPSLatitude: PLANTED_GPS.latitude,
    GPSLongitudeRef: 'W',
    GPSLongitude: PLANTED_GPS.longitude,
    GPSDateStamp: '2001:02:03',
    GPSTimeStamp: '3/1 5/1 6/1',
  };
  clips.photo = join(directory, 'turned.heic');
  await photo(
    clips.photo,
    { IFD2: { DateTimeOriginal: '2001:02:03 04:05:06', OffsetTimeOriginal: '+01:00' }, IFD3: gps },
    6,
  );
  clips.localPhoto = join(directory, 'local.heic');
  await photo(
    clips.localPhoto,
    { IFD2: { DateTimeOriginal: '2001:02:03 04:05:06' }, IFD3: gps },
    1,
  );
});
after(async () => {
  await rm(directory, { recursive: true, force: true });
});

/** A fresh store, with each named file placed in it under its own SHA-256 as the CLI does. */
async function setup(helperPath = helper) {
  const store = await mkdtemp(join(directory, 'store-'));
  const journal = Journal.open(':memory:');
  const media = new MediaStore(null);
  const scenes = new RecordedScenes({ journal, media, directory: store, helper: helperPath });
  const place = async (file: string, extension: string) => {
    const sha256 = createHash('sha256')
      .update(await readFile(file))
      .digest('hex');
    await copyFile(file, join(store, `${sha256}.${extension}`));
    await chmod(join(store, `${sha256}.${extension}`), 0o600);
    return sha256;
  };
  return { store, journal, media, scenes, place };
}

async function centerColor(jpeg: Buffer) {
  const { data, info } = await sharp(jpeg).raw().toBuffer({ resolveWithObject: true });
  const at = (x: number, y: number) =>
    Array.from(
      data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3),
    );
  return {
    size: `${info.width}x${info.height}`,
    center: at(info.width >> 1, info.height >> 1),
    top: at(info.width >> 1, 1),
    bottom: at(info.width >> 1, info.height - 2),
  };
}
const near = (actual: number[], expected: readonly number[]) =>
  actual.every((channel, index) => Math.abs(channel - (expected[index] ?? 0)) <= 48);
/** Which palette color a still shows: decoders differ in color math, never in which frame. */
const paletteIndex = (actual: number[]) =>
  PALETTE.map((color) =>
    color.reduce((sum, channel, index) => sum + (channel - (actual[index] ?? 0)) ** 2, 0),
  ).reduce((best, distance, index, all) => (distance < (all[best] as number) ? index : best), 0);

async function refusal(work: Promise<unknown> | (() => unknown), code: string) {
  await assert.rejects(
    async () => (typeof work === 'function' ? work() : work),
    (error: unknown) => error instanceof BoopyError && error.code === code,
  );
}

describe('recorded import', () => {
  it('keeps each sampled frame exact through an edit list, variable frame times and a display turn', async (context) => {
    if (missing) return context.skip(missing);
    const { scenes, media, journal, place } = await setup();
    const sha256 = await place(clips.palette as string, 'mov');
    const summary = await scenes.importSource({
      sha256,
      extension: 'mov',
      sampling: { mode: 'every', seconds: 0.1 },
    });
    const times = displayedTimes(clips.palette as string);
    const imported = journal.all().find((event) => event.type === 'recorded.source.imported');
    assert.ok(imported?.type === 'recorded.source.imported');
    const frames = imported.data.frames;
    // Sampling every 0.1 s over 1.6 s shows each of the 12 frames once.
    assert.equal(summary.frames, 12);
    assert.deepEqual(
      frames.map((frame) => frame.seconds),
      times,
    );
    for (const [index, frame] of frames.entries()) {
      const still = await centerColor(media.get(frame.frameSha256, 'jpg'));
      // Upright: the 64x48 store turns to 48x64 and the left stripe ends at the bottom.
      assert.equal(still.size, '48x64');
      assert.ok(near(still.bottom, [255, 255, 255]), `frame ${index} stripe at the bottom`);
      assert.equal(paletteIndex(still.center), index, `frame ${index} color`);
    }
    assert.equal(imported.data.kind, 'video');
    assert.equal(imported.data.width, 48);
    assert.equal(imported.data.height, 64);
    assert.equal(imported.data.hdr, false);
    assert.equal(imported.data.captureOrigin.status, 'unknown');
    assert.match(imported.data.recordingId, /^rec_[a-f0-9]{32}$/);
    assert.ok(frames.every((frame) => /^rfr_[a-f0-9]{32}$/.test(frame.frameId)));
    // No file name, store path or folder reaches the journal.
    const row = JSON.stringify(journal.all());
    for (const secret of ['palette', directory, '.mov'])
      assert.equal(row.includes(secret), false, secret);
  });

  it('picks the frame shown at each chosen moment, and evenly spaced stills', async (context) => {
    if (missing) return context.skip(missing);
    const { scenes, journal, media, place } = await setup();
    const sha256 = await place(clips.palette as string, 'mov');
    await scenes.importSource({
      sha256,
      extension: 'mov',
      sampling: { mode: 'at', seconds: [0.75, 0, 1.59] },
    });
    await scenes.importSource({ sha256, extension: 'mov', sampling: { mode: 'stills', count: 4 } });
    const [at, stills] = journal.all().filter((event) => event.type === 'recorded.source.imported');
    assert.ok(
      at?.type === 'recorded.source.imported' && stills?.type === 'recorded.source.imported',
    );
    // 0.75 s shows the frame from 0.6 s; moments come back in time order.
    assert.deepEqual(
      at.data.frames.map((frame) => frame.seconds),
      [0, 0.6, 1.4],
    );
    assert.equal(
      paletteIndex(
        (await centerColor(media.get(at.data.frames[1]?.frameSha256 ?? '', 'jpg'))).center,
      ),
      6,
    );
    assert.deepEqual(
      stills.data.frames.map((frame) => frame.seconds),
      [0, 0.4, 0.8, 1.2],
    );
  });

  it('maps HLG video to an 8-bit standard range still with no metadata', async (context) => {
    if (missing) return context.skip(missing);
    const { scenes, journal, media, place } = await setup();
    const sha256 = await place(clips.hlg as string, 'mov');
    await scenes.importSource({ sha256, extension: 'mov', sampling: { mode: 'stills', count: 1 } });
    const imported = journal.all().find((event) => event.type === 'recorded.source.imported');
    assert.ok(imported?.type === 'recorded.source.imported');
    assert.equal(imported.data.hdr, true);
    const still = media.get(imported.data.frames[0]?.frameSha256 ?? '', 'jpg');
    const metadata = await sharp(still).metadata();
    assert.equal(metadata.format, 'jpeg');
    assert.equal(metadata.depth, 'uchar');
    for (const key of ['exif', 'icc', 'xmp', 'iptc'] as const)
      assert.equal(metadata[key], undefined, key);
  });

  it('reads a video capture time from its tags as unverified, and a disagreement as a conflict', async (context) => {
    if (missing) return context.skip(missing);
    const { scenes, journal, place } = await setup();
    await scenes.importSource({
      sha256: await place(clips.dated as string, 'mov'),
      extension: 'mov',
      sampling: { mode: 'stills', count: 2 },
    });
    await scenes.importSource({
      sha256: await place(clips.conflict as string, 'mov'),
      extension: 'mov',
      sampling: { mode: 'stills', count: 2 },
    });
    const [dated, conflict] = journal
      .all()
      .filter((event) => event.type === 'recorded.source.imported');
    assert.ok(
      dated?.type === 'recorded.source.imported' && conflict?.type === 'recorded.source.imported',
    );
    assert.equal(dated.data.captureOrigin.value, '2001-02-03T04:05:06.000Z');
    assert.equal(dated.data.captureOrigin.trust, 'unverified');
    assert.equal(conflict.data.captureOrigin.status, 'conflict');
    assert.equal(conflict.data.captureOrigin.value, null);
  });

  it('turns a photo upright, keeps its offset time unverified and never reads its GPS', async (context) => {
    if (missing) return context.skip(missing);
    const { scenes, journal, media, place } = await setup();
    const sha256 = await place(clips.photo as string, 'heic');
    const summary = await scenes.importSource({ sha256, extension: 'heic' });
    assert.equal(summary.kind, 'photo');
    const imported = journal.all().find((event) => event.type === 'recorded.source.imported');
    assert.ok(imported?.type === 'recorded.source.imported');
    assert.equal(imported.data.durationSeconds, null);
    assert.equal(imported.data.frames[0]?.seconds, null);
    assert.equal(imported.data.captureOrigin.value, '2001-02-03T03:05:06.000Z');
    assert.deepEqual(imported.data.captureOrigin.sources, ['exif:DateTimeOriginal']);
    const still = media.get(imported.data.frames[0]?.frameSha256 ?? '', 'jpg');
    const look = await centerColor(still);
    // Orientation 6: the left stripe ends at the top of the upright picture.
    assert.equal(look.size, '48x64');
    assert.ok(near(look.top, [255, 255, 255]));
    assert.equal((await sharp(still).metadata()).exif, undefined);
    scenes.show({ recordingId: summary.recordingId });
    const probe = spawnSync(helper, ['probe-photo', clips.photo as string]).stdout.toString();
    const everything = [
      JSON.stringify(journal.all()),
      JSON.stringify(scenes.scene()),
      still.toString('latin1'),
      probe,
    ];
    for (const text of everything)
      for (const digits of ['4321', '8765', '43.21', '87.65', 'GPS'])
        assert.equal(text.includes(digits), false, digits);
  });

  it('leaves a photo time without an offset unresolved, even with a GPS time stamp beside it', async (context) => {
    if (missing) return context.skip(missing);
    const { scenes, journal, place } = await setup();
    await scenes.importSource({
      sha256: await place(clips.localPhoto as string, 'heic'),
      extension: 'heic',
    });
    const imported = journal.all().find((event) => event.type === 'recorded.source.imported');
    assert.ok(imported?.type === 'recorded.source.imported');
    assert.equal(imported.data.captureOrigin.value, null);
    assert.equal(imported.data.captureOrigin.timezone, 'missing');
    assert.deepEqual(imported.data.captureOrigin.sources, ['exif:DateTimeOriginal']);
  });

  it('returns the same recording for the same file and sampling, without a second event', async (context) => {
    if (missing) return context.skip(missing);
    const { scenes, journal, place } = await setup();
    const sha256 = await place(clips.palette as string, 'mov');
    const first = await scenes.importSource({
      sha256,
      extension: 'mov',
      sampling: { mode: 'stills', count: 2 },
    });
    const again = await scenes.importSource({
      sha256,
      extension: 'mov',
      sampling: { mode: 'stills', count: 2 },
    });
    assert.equal(again.recordingId, first.recordingId);
    assert.equal(again.reused, true);
    assert.equal(journal.all().length, 1);
  });

  it('refuses a file whose bytes do not match its name, a link, an unknown kind and bad sampling', async (context) => {
    if (missing) return context.skip(missing);
    const { scenes, journal, store, place } = await setup();
    const sha256 = await place(clips.palette as string, 'mov');
    const other = 'a'.repeat(64);
    await copyFile(clips.palette as string, join(store, `${other}.mov`));
    await refusal(
      scenes.importSource({ sha256: other, extension: 'mov' }),
      'recorded_sha_mismatch',
    );
    await symlink(join(store, `${sha256}.mov`), join(store, `${'b'.repeat(64)}.mov`));
    await refusal(
      scenes.importSource({ sha256: 'b'.repeat(64), extension: 'mov' }),
      'recorded_source_missing',
    );
    await refusal(
      scenes.importSource({ sha256: 'c'.repeat(64), extension: 'mov' }),
      'recorded_source_missing',
    );
    await refusal(scenes.importSource({ sha256, extension: 'avi' }), 'recorded_invalid');
    await refusal(scenes.importSource({ sha256: '../x', extension: 'mov' }), 'recorded_invalid');
    // Every 1/15 s over a whole 61 s clip would be 900 frames, and a clip over 60 s needs a window.
    const long = await place(clips.long as string, 'mov');
    await refusal(
      scenes.importSource({ sha256: long, extension: 'mov' }),
      'recorded_window_required',
    );
    await refusal(
      scenes.importSource({
        sha256: long,
        extension: 'mov',
        sampling: { mode: 'every', seconds: 0.05, startSeconds: 0, durationSeconds: 61 },
      }),
      'recorded_invalid',
    );
    await refusal(
      scenes.importSource({
        sha256: long,
        extension: 'mov',
        sampling: { mode: 'at', seconds: [61.5] },
      }),
      'recorded_invalid',
    );
    const photoSha = await place(clips.photo as string, 'heic');
    await refusal(
      scenes.importSource({
        sha256: photoSha,
        extension: 'heic',
        sampling: { mode: 'stills', count: 2 },
      }),
      'recorded_invalid',
    );
    assert.equal(journal.all().length, 0);
  });

  it('takes a window of a long clip, and removes its work folder after success and after failure', async (context) => {
    if (missing) return context.skip(missing);
    const failing = join(directory, 'failing-helper.zsh');
    await writeFile(
      failing,
      `#!/bin/zsh\nif [[ $1 == stills-video ]]; then print -r -- partial > $3/0.jpg; print '{"error":"still_decode"}'; exit 2; fi\nexec ${helper} "$@"\n`,
      { mode: 0o700 },
    );
    const good = await setup();
    const long = await good.place(clips.long as string, 'mov');
    const window = await good.scenes.importSource({
      sha256: long,
      extension: 'mov',
      sampling: { mode: 'every', seconds: 1, startSeconds: 10, durationSeconds: 5 },
    });
    assert.equal(window.frames, 5);
    assert.deepEqual(await readdir(good.store), [`${long}.mov`]);
    const bad = await setup(failing);
    const sha256 = await bad.place(clips.palette as string, 'mov');
    await refusal(bad.scenes.importSource({ sha256, extension: 'mov' }), 'recorded_decode_failed');
    assert.deepEqual(await readdir(bad.store), [`${sha256}.mov`]);
    assert.equal(bad.journal.all().length, 0);
  });
});

describe('recorded scene', () => {
  async function shown() {
    const parts = await setup();
    const sha256 = await parts.place(clips.palette as string, 'mov');
    const one = await parts.scenes.importSource({
      sha256,
      extension: 'mov',
      sampling: { mode: 'stills', count: 4 },
    });
    const two = await parts.scenes.importSource({
      sha256,
      extension: 'mov',
      sampling: { mode: 'stills', count: 2 },
    });
    return { ...parts, one, two };
  }

  it('shows nothing until the operator shows a recording, then its frames and the shown frame', async (context) => {
    if (missing) return context.skip(missing);
    const { scenes, one, media } = await shown();
    assert.equal(scenes.scene(), null);
    scenes.show({ recordingId: one.recordingId, atSeconds: 0.5 });
    const scene = scenes.scene();
    assert.ok(scene !== null);
    assert.equal(scene.recordingId, one.recordingId);
    assert.equal(scene.kind, 'video');
    assert.equal(scene.frames.length, 4);
    // 0.5 s shows the still taken at 0.4 s.
    assert.equal(scene.sourceTimeSeconds, 0.4);
    assert.equal(scene.frameId, scene.frames[1]?.frameId);
    assert.deepEqual(scene.capturedAt, { value: null, trust: 'unknown' });
    assert.deepEqual(Object.keys(scene).sort(), [
      'capturedAt',
      'durationSeconds',
      'frameId',
      'frameSha256',
      'frames',
      'height',
      'kind',
      'recordingId',
      'sourceTimeSeconds',
      'width',
    ]);
    const jpeg = scenes.frame(scene.frames[3]?.frameId ?? '');
    assert.deepEqual(jpeg, media.get(scene.frames[3]?.frameSha256 ?? '', 'jpg'));
  });

  it('binds a boop to a frame of the shown recording, and refuses one from a scene that changed', async (context) => {
    if (missing) return context.skip(missing);
    const { scenes, one, two } = await shown();
    await refusal(
      () => scenes.resolve({ recordingId: one.recordingId, frameId: 'rfr_'.padEnd(36, '0') }),
      'recorded_frame_changed',
    );
    scenes.show({ recordingId: one.recordingId });
    const scene = scenes.scene();
    const frameId = scene?.frames[2]?.frameId ?? '';
    const resolved = scenes.resolve({ recordingId: one.recordingId, frameId });
    assert.equal(resolved.recorded.frameId, frameId);
    assert.equal(resolved.recorded.seconds, 0.8);
    assert.equal(resolved.capturedAt, null);
    assert.equal(resolved.frameSha256, scene?.frames[2]?.frameSha256);
    await refusal(
      () => scenes.resolve({ recordingId: one.recordingId, frameId: 'rfr_'.padEnd(36, '1') }),
      'recorded_frame_unknown',
    );
    await refusal(() => scenes.frame('rfr_'.padEnd(36, '1')), 'recorded_frame_unknown');
    scenes.show({ recordingId: two.recordingId });
    await refusal(
      () => scenes.resolve({ recordingId: one.recordingId, frameId }),
      'recorded_frame_changed',
    );
    await refusal(() => scenes.frame(frameId), 'recorded_frame_unknown');
    scenes.clear();
    assert.equal(scenes.scene(), null);
    await refusal(() => scenes.clear(), 'recorded_scene_none');
    await refusal(() => scenes.show({ recordingId: 'rec_'.padEnd(36, '0') }), 'recorded_unknown');
  });

  it('rebuilds recordings and the shown scene from the journal', async (context) => {
    if (missing) return context.skip(missing);
    const { scenes, journal, media, store, one } = await shown();
    scenes.show({ recordingId: one.recordingId });
    const again = new RecordedScenes({ journal, media, directory: store, helper });
    assert.deepEqual(again.scene(), scenes.scene());
    assert.deepEqual(again.recordings(), scenes.recordings());
  });

  it('gives a frame its capture time from the recording start when the file has one', async (context) => {
    if (missing) return context.skip(missing);
    const { scenes, place } = await setup();
    const dated = await scenes.importSource({
      sha256: await place(clips.dated as string, 'mov'),
      extension: 'mov',
      sampling: { mode: 'at', seconds: [0.6] },
    });
    scenes.show({ recordingId: dated.recordingId });
    assert.deepEqual(scenes.scene()?.capturedAt, {
      value: '2001-02-03T04:05:06.600Z',
      trust: 'unverified',
    });
  });
});

describe('a journal for recorded scenes', () => {
  it('refuses a journal that already holds a live capture', () => {
    const journal = Journal.open(':memory:');
    assert.doesNotThrow(() => assertNoLiveCaptures(journal));
    journal.append(
      {
        type: 'observation.recorded',
        session: 'ses_1',
        actor: 'person',
        data: {
          observationId: 'obs_1',
          frameSha256: 'f'.repeat(64),
          width: 1,
          height: 1,
          capturedAt: '1970-01-01T00:00:00.000Z',
          camera: null,
          depth: null,
          cues: {},
        },
      },
      'evt_1',
      '1970-01-01T00:00:00.000Z',
    );
    assert.throws(() => assertNoLiveCaptures(journal), /live capture/);
  });
});

it('keeps the store folder private', async (context) => {
  if (missing) return context.skip(missing);
  const store = join(directory, 'made-store');
  new RecordedScenes({
    journal: Journal.open(':memory:'),
    media: new MediaStore(null),
    directory: store,
    helper,
  });
  assert.equal((await stat(store)).mode & 0o777, 0o700);
});
