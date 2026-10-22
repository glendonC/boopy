import assert from 'node:assert/strict';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, before, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  decodeRecordedFrames,
  inspectRecordedMedia,
  makeRecordedMediaTool,
  RecordedMediaError,
  type RecordedMediaTool,
} from './recorded-media.ts';

let directory: string;
let clip: string;

// This is only a structural container for guard/test-double tests, not encoded media.
function atom(kind: string, ...body: Buffer[]): Buffer {
  const content = Buffer.concat(body);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(content.length + header.length);
  header.write(kind, 4, 'latin1');
  return Buffer.concat([header, content]);
}
function structuralContainer(): Buffer {
  const sample = Buffer.alloc(78);
  sample.writeUInt16BE(1, 6);
  const fullBox = Buffer.alloc(8);
  fullBox.writeUInt32BE(1, 4);
  const selfReference = Buffer.alloc(4);
  selfReference.writeUInt32BE(1);
  return Buffer.concat([
    atom('ftyp', Buffer.from('isom0000')),
    atom(
      'moov',
      atom(
        'trak',
        atom(
          'mdia',
          atom(
            'minf',
            atom('dinf', atom('dref', fullBox, atom('url ', selfReference))),
            atom('stbl', atom('stsd', fullBox, atom('avc1', sample, atom('avcC')))),
          ),
        ),
      ),
    ),
    atom('free'),
    atom('mdat', Buffer.from('synthetic-structural-test-data')),
  ]);
}
before(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'boopy-recorded-synthetic-')));
  clip = join(directory, 'structural.mov');
  await writeFile(clip, structuralContainer());
});
after(async () => {
  await rm(directory, { recursive: true, force: true });
});

function optionalToolsUnavailable(): string | false {
  return ['/opt/homebrew/bin/ffmpeg', '/opt/homebrew/bin/ffprobe']
    .map((path) => spawnSync(path, ['-version'], { timeout: 5000, maxBuffer: 16_384 }))
    .some(
      (result) =>
        result.error &&
        'code' in result.error &&
        ['ENOENT', 'ENOTDIR', 'EACCES'].includes(String(result.error.code)),
    )
    ? 'Optional installed FFmpeg/FFprobe unavailable; real codec proof was not run.'
    : false;
}

function encodeClip(encoder: string, extra: string[]): string {
  const output = join(directory, `synthetic-${encoder}.${encoder === 'libx264' ? 'mov' : 'mp4'}`);
  const colors = [
    [255, 0, 0],
    [0, 255, 0],
    [0, 0, 255],
    [255, 255, 255],
  ];
  const pixels = Buffer.concat(
    colors.map((color) => {
      const frame = Buffer.alloc(96 * 64 * 3);
      for (let pixel = 0; pixel < frame.length; pixel += 3) frame.set(color, pixel);
      return frame;
    }),
  );
  const result = spawnSync(
    '/opt/homebrew/bin/ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostdin',
      '-threads',
      '1',
      '-f',
      'rawvideo',
      '-pixel_format',
      'rgb24',
      '-video_size',
      '96x64',
      '-framerate',
      '2',
      '-i',
      'pipe:0',
      '-vf',
      'setsar=1',
      '-c:v',
      encoder,
      ...extra,
      '-threads',
      '1',
      '-bf',
      '0',
      '-pix_fmt',
      'yuv420p',
      '-use_editlist',
      '0',
      '-movflags',
      '+faststart',
      '-y',
      output,
    ],
    { timeout: 10_000, maxBuffer: 16_384, input: pixels },
  );
  assert.equal(result.status, 0, 'synthetic encoder must succeed');
  return output;
}

const metadata = () => ({
  streams: [
    {
      index: 0,
      codec_type: 'video',
      codec_name: 'h264',
      codec_tag_string: 'avc1',
      width: 96,
      height: 64,
      pix_fmt: 'yuv420p',
      time_base: '1/16384',
      start_pts: 0,
      duration_ts: 32768,
      nb_frames: '4',
      color_transfer: 'unknown',
      tags: {},
    },
  ],
  format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '2.000000', tags: {} },
});
const syntheticFrame = (pts: number, duration = 8192, width = 96, height = 64) => ({
  pts,
  duration,
  width,
  height,
  pix_fmt: 'yuv420p',
  sample_aspect_ratio: '1:1',
  interlaced_frame: 0,
});
const frames = () => ({ frames: [0, 8192, 16384, 24576].map((pts) => syntheticFrame(pts)) });
function fakeTool(change?: (value: ReturnType<typeof metadata>) => void): RecordedMediaTool {
  return async (request) => {
    assert.equal(request.args.includes('pipe:0'), true);
    assert.equal(request.args.includes('-protocol_whitelist'), true);
    assert.equal(request.args.includes('-enable_drefs'), true);
    assert.equal(request.args.includes('-use_absolute_path'), true);
    assert.equal(request.args.includes(clip), false);
    assert.ok(request.source.length > 0);
    if (request.tool === 'ffmpeg') return Buffer.alloc(96 * 64 * 3 * 4);
    if (request.args.includes('-show_frames')) return Buffer.from(JSON.stringify(frames()));
    const value = metadata();
    change?.(value);
    return Buffer.from(JSON.stringify(value));
  };
}
function audioTool(change?: (audio: Record<string, unknown>) => void): RecordedMediaTool {
  return fakeTool((value) => {
    const audio = Object.assign({}, value.streams[0], {
      index: 1,
      codec_type: 'audio',
      codec_name: 'aac',
      codec_tag_string: 'mp4a',
      channels: 1,
      sample_rate: '48000',
      time_base: '1/48000',
      duration_ts: 96000,
    });
    change?.(audio);
    value.streams.push(audio);
  });
}
async function code(operation: Promise<unknown>, expected: string) {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof RecordedMediaError);
    assert.equal(error.code, expected);
    assert.equal(error.message, expected);
    return true;
  });
}

it('inspects and decodes only a bounded synthetic clip with exact source PTS', async (context) => {
  const unavailable = optionalToolsUnavailable();
  if (unavailable) {
    context.skip(unavailable);
    return;
  }
  const input = encodeClip('libx264', []);
  const info = await inspectRecordedMedia(input);
  assert.equal(info.videoFrames, 4);
  assert.equal(info.audioTracks, 0);
  assert.equal(info.captureOrigin.value, null);
  assert.equal(info.captureOrigin.status, 'unknown');
  assert.deepEqual(info.sourceTimeBase, { numerator: 1, denominator: 16384 });
  const result = await decodeRecordedFrames(input, { startSeconds: 0.5, durationSeconds: 1 });
  assert.deepEqual(
    result.frames.map((frame) => frame.sourcePts),
    [8192, 16384],
  );
  assert.equal(result.frames[0]?.rgb.length, 96 * 64 * 3);
  assert.ok((result.frames[0]?.rgb[1] ?? 0) > 240);
  assert.ok((result.frames[0]?.rgb[0] ?? 255) < 15);
  assert.ok((result.frames[1]?.rgb[2] ?? 0) > 240);
  assert.ok((result.frames[1]?.rgb[1] ?? 255) < 15);
  assert.equal(result.sourceSha256, info.sourceSha256);
  assert.match(info.sourceSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(result.sourceTimeBase, info.sourceTimeBase);
  assert.equal('capturedAt' in result, false);
  assert.equal('replayedAt' in result, false);
});

it('decodes the explicitly hvc1-tagged synthetic HEVC route without timeline rewriting', async (context) => {
  const unavailable = optionalToolsUnavailable();
  if (unavailable) {
    context.skip(unavailable);
    return;
  }
  const input = encodeClip('libx265', [
    '-tag:v',
    'hvc1',
    '-x265-params',
    'pools=none:frame-threads=1:log-level=error',
  ]);
  const result = await decodeRecordedFrames(input, { startSeconds: 0.5, durationSeconds: 1 });
  assert.deepEqual(
    result.frames.map((frame) => frame.sourcePts),
    [8192, 16384],
  );
  assert.ok((result.frames[0]?.rgb[1] ?? 0) > 240);
  assert.ok((result.frames[1]?.rgb[2] ?? 0) > 240);
});

it('runs bounded inspect/decode with structural bytes and a test double without codec tools', async () => {
  const info = await inspectRecordedMedia(clip, { tool: fakeTool() });
  const result = await decodeRecordedFrames(
    clip,
    { startSeconds: 0.5, durationSeconds: 1 },
    {
      tool: async (request) =>
        request.tool === 'ffmpeg' ? Buffer.alloc(96 * 64 * 3 * 2) : fakeTool()(request),
    },
  );
  assert.deepEqual(
    result.frames.map((frame) => frame.sourcePts),
    [8192, 16384],
  );
  assert.equal(result.frames[0]?.rgb.length, 96 * 64 * 3);
  assert.equal(result.sourceSha256, info.sourceSha256);
  assert.equal(info.captureOrigin.status, 'unknown');
  assert.equal(JSON.stringify(info).includes(clip), false);
});

it('accepts AAC metadata only with zero start and exactly equal rational duration', async () => {
  for (const [numerator, denominator, ticks] of [
    [1, 48000, 96000],
    [2, 48000, 48000],
  ]) {
    const info = await inspectRecordedMedia(clip, {
      tool: audioTool((audio) => {
        audio.time_base = `${numerator}/${denominator}`;
        audio.duration_ts = ticks;
      }),
    });
    assert.equal(info.audioTracks, 1);
    assert.equal(info.durationSeconds, 2);
  }
});

for (const [label, change, expected] of [
  [
    'short',
    (audio) => {
      audio.duration_ts = 24000;
    },
    'unsupported_timeline',
  ],
  [
    'long',
    (audio) => {
      audio.duration_ts = 144000;
    },
    'unsupported_timeline',
  ],
  [
    'one tick short',
    (audio) => {
      audio.duration_ts = 95999;
    },
    'unsupported_timeline',
  ],
  [
    'one tick long',
    (audio) => {
      audio.duration_ts = 96001;
    },
    'unsupported_timeline',
  ],
  [
    'zero',
    (audio) => {
      audio.duration_ts = 0;
    },
    'unsupported_timeline',
  ],
  [
    'negative',
    (audio) => {
      audio.duration_ts = -1;
    },
    'unsupported_timeline',
  ],
  [
    'offset',
    (audio) => {
      audio.start_pts = 1024;
    },
    'unsupported_timeline',
  ],
  [
    'missing duration',
    (audio) => {
      delete audio.duration_ts;
    },
    'invalid_probe',
  ],
  [
    'missing time base',
    (audio) => {
      delete audio.time_base;
    },
    'invalid_probe',
  ],
  [
    'invalid time base',
    (audio) => {
      audio.time_base = '1/0';
    },
    'invalid_probe',
  ],
  [
    'fractional duration',
    (audio) => {
      audio.duration_ts = 1.5;
    },
    'invalid_probe',
  ],
  [
    'unsafe duration',
    (audio) => {
      audio.duration_ts = Number.MAX_SAFE_INTEGER + 1;
    },
    'invalid_probe',
  ],
] as const satisfies readonly (readonly [
  string,
  (audio: Record<string, unknown>) => void,
  string,
])[]) {
  it(`refuses ${label} AAC timeline metadata without alignment inference`, async () => {
    await code(inspectRecordedMedia(clip, { tool: audioTool(change) }), expected);
  });
}
