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

if (process.env.BOOPY_TEST_NO_MEDIA_TOOLS !== '1') {
  it('executes core guards and explicitly skips codec proof with both optional tools absent', async (context) => {
    const preload = join(directory, 'missing-tools.mjs');
    await writeFile(
      preload,
      `
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const isTool = (file) => ['/opt/homebrew/bin/ffmpeg', '/opt/homebrew/bin/ffprobe'].includes(file);
const missing = () => Object.assign(new Error('Synthetic missing optional tool.'), { code: 'ENOENT' });
const originalSync = childProcess.spawnSync;
const originalSpawn = childProcess.spawn;
childProcess.spawnSync = (file, ...args) => isTool(file)
  ? { pid: 0, output: [null, null, null], stdout: null, stderr: null, status: null,
      signal: null, error: missing() }
  : originalSync(file, ...args);
childProcess.spawn = (file, ...args) => { if (isTool(file)) throw missing(); return originalSpawn(file, ...args); };
syncBuiltinESMExports();
`,
    );
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        preload,
        '--test',
        '--test-reporter=spec',
        'src/recorded-media.test.ts',
        'src/cli/replay.test.ts',
      ],
      {
        cwd: fileURLToPath(new URL('../', import.meta.url)),
        env: {
          PATH: process.env.PATH ?? '',
          NODE_NO_WARNINGS: '1',
          BOOPY_TEST_NO_MEDIA_TOOLS: '1',
        },
        timeout: 10_000,
        maxBuffer: 65_536,
        encoding: 'utf8',
      },
    );
    assert.equal(result.status, 0, 'core guard suite must pass with optional tools absent');
    assert.match(result.stdout, /pass [1-9]\d*/);
    assert.match(result.stdout, /fail 0\b/);
    assert.match(result.stdout, /skipped 2\b/);
    assert.match(
      result.stdout,
      /Optional installed FFmpeg\/FFprobe unavailable; real codec proof was not run/,
    );
    context.diagnostic(
      `Optional tools absent child: ${['tests', 'pass', 'fail', 'skipped']
        .map(
          (field) =>
            `${field} ${new RegExp(`${field} (\\d+)`).exec(result.stdout)?.[1] ?? 'unknown'}`,
        )
        .join('; ')}.`,
    );
    for (const guard of [
      'rejects URL, network and control-containing paths',
      'rejects edit lists and external references',
      'refuses mismatched decoded byte count and sanitizes untrusted tool failures',
      'kills and waits for its only child on timeout budget exhaustion',
      'does not print raw diagnostic messages, paths or metadata',
    ])
      assert.ok(result.stdout.includes(guard), `missing core guard: ${guard}`);
  });
}

it('rejects empty and oversized regular files before any child', async () => {
  const input = join(directory, 'size-limit.mov');
  await writeFile(input, '');
  await code(inspectRecordedMedia(input), 'media_limit');
  await truncate(input, 128 * 1024 * 1024 + 1);
  await code(
    inspectRecordedMedia(input, {
      tool: async () => {
        assert.fail('no child');
      },
    }),
    'media_limit',
  );
});

it('never passes an operator path to a child or returns raw unselected metadata', async () => {
  const result = await inspectRecordedMedia(clip, {
    tool: fakeTool((value) => {
      Object.assign(value.format.tags, { location: 'private-marker', title: 'private-marker' });
    }),
  });
  assert.equal(JSON.stringify(result).includes('private-marker'), false);
  assert.equal(JSON.stringify(result).includes(clip), false);
});

it('capture date is an unverified metadata claim with explicit offset, never replay-now', async () => {
  const result = await inspectRecordedMedia(clip, {
    tool: fakeTool((value) => {
      Object.assign(value.format.tags, { creation_time: '2020-01-02T03:04:05+02:00' });
    }),
  });
  assert.deepEqual(result.captureOrigin, {
    value: '2020-01-02T01:04:05.000Z',
    source: 'metadata',
    trust: 'unverified',
    timezone: 'explicit',
    status: 'unverified',
    sources: ['format:creation_time'],
  });
});

for (const [tags, status, timezone] of [
  [{ creation_time: '2020-01-02T03:04:05' }, 'unknown', 'missing'],
  [{ creation_time: 'not-a-date' }, 'unknown', 'unknown'],
  [{ creation_time: '2020-02-30T03:04:05Z' }, 'unknown', 'unknown'],
  [
    {
      creation_time: '2020-01-02T03:04:05Z',
      'com.apple.quicktime.creationdate': '2020-01-03T03:04:05Z',
    },
    'conflict',
    'explicit',
  ],
] as const) {
  it(`keeps ${status}/${timezone} capture metadata unresolved`, async () => {
    const result = await inspectRecordedMedia(clip, {
      tool: fakeTool((value) => {
        Object.assign(value.format.tags, tags);
      }),
    });
    assert.equal(result.captureOrigin.value, null);
    assert.equal(result.captureOrigin.status, status);
    assert.equal(result.captureOrigin.timezone, timezone);
    assert.equal(result.captureOrigin.trust, 'unknown');
  });
}

it('conflicting container and stream dates stay unresolved', async () => {
  const result = await inspectRecordedMedia(clip, {
    tool: fakeTool((value) => {
      Object.assign(value.format.tags, { creation_time: '2020-01-02T03:04:05Z' });
      Object.assign(value.streams[0]?.tags ?? {}, { creation_time: '2020-01-03T03:04:05Z' });
    }),
  });
  assert.equal(result.captureOrigin.status, 'conflict');
  assert.equal(result.captureOrigin.value, null);
});

for (const input of [
  'https://example.invalid/clip.mov',
  'file:///tmp/clip.mov',
  '//host/clip.mov',
  'clip\u{000A}.mov',
]) {
  it('rejects URL, network and control-containing paths before any child', async () => {
    await code(
      inspectRecordedMedia(input, {
        tool: async () => {
          assert.fail('no child');
        },
      }),
      'invalid_input',
    );
  });
}
it('rejects directories, symlink files and symlink parent directories', async () => {
  await mkdir(join(directory, 'nested'));
  await symlink(clip, join(directory, 'linked.mov'));
  await symlink(directory, join(directory, 'linked-directory'));
  for (const input of [
    directory,
    join(directory, 'linked.mov'),
    join(directory, 'linked-directory', 'structural.mov'),
  ]) {
    await code(inspectRecordedMedia(input), 'invalid_input');
  }
});

it('refuses playlists and malformed atoms without a child', async () => {
  const path = join(directory, 'playlist.mov');
  await writeFile(path, '#EXTM3U\nhttps://example.invalid/clip.mov');
  await code(
    inspectRecordedMedia(path, {
      tool: async () => {
        assert.fail('no child');
      },
    }),
    'unsupported_container',
  );
});

it('rejects edit lists and external references before a child', async () => {
  const original = await readFile(clip);
  for (const [needle, replacement, expected] of [
    ['free', 'edts', 'unsupported_edits'],
    ['url ', 'alis', 'external_reference'],
  ]) {
    const bytes = Buffer.from(original);
    const offset =
      needle === 'url '
        ? bytes.indexOf(Buffer.from([0, 0, 0, 12, 0x75, 0x72, 0x6c, 0x20])) + 4
        : bytes.indexOf(needle ?? '');
    if (needle === 'free' && offset < 0) {
      const atom = Buffer.alloc(8);
      atom.writeUInt32BE(8);
      atom.write('edts', 4);
      const path = join(directory, 'edit.mov');
      await writeFile(path, Buffer.concat([bytes, atom]));
      await code(inspectRecordedMedia(path), expected ?? '');
      continue;
    }
    assert.ok(offset >= 4);
    if (needle === 'url ') assert.equal(bytes.readUInt32BE(offset - 4), 12);
    bytes.write(replacement ?? '', offset);
    const path = join(directory, `${needle?.trim()}.mov`);
    await writeFile(path, bytes);
    await code(
      inspectRecordedMedia(path, {
        tool: async () => {
          assert.fail('no child');
        },
      }),
      expected ?? '',
    );
  }
});

for (const [change, expected] of [
  [
    (value: ReturnType<typeof metadata>) => {
      Object.assign(value.streams[0] ?? {}, { width: 4000 });
    },
    'media_limit',
  ],
  [
    (value: ReturnType<typeof metadata>) => {
      value.format.duration = '1801';
    },
    'media_limit',
  ],
  [
    (value: ReturnType<typeof metadata>) => {
      Object.assign(value.streams[0] ?? {}, { pix_fmt: 'yuv420p10le' });
    },
    'unsupported_video',
  ],
  [
    (value: ReturnType<typeof metadata>) => {
      Object.assign(value.streams[0] ?? {}, { color_transfer: 'smpte2084' });
    },
    'unsupported_video',
  ],
  [
    (value: ReturnType<typeof metadata>) => {
      Object.assign(value.streams[0] ?? {}, { side_data_list: [{ rotation: 90 }] });
    },
    'unsupported_video',
  ],
  [
    (value: ReturnType<typeof metadata>) => {
      Object.assign(value.streams[0] ?? {}, { start_pts: 100 });
    },
    'unsupported_timeline',
  ],
] as const) {
  it(`fails closed on unsupported metadata (${expected})`, async () => {
    await code(inspectRecordedMedia(clip, { tool: fakeTool(change) }), expected);
  });
}

it('fails on variable, repeated or discontinuous timestamps instead of inventing CFR', async () => {
  for (const pts of [
    [0, 8192, 16400, 24576],
    [0, 8192, 8192, 24576],
    [0, 8192, 24576, 32768],
  ]) {
    const tool = fakeTool();
    await code(
      inspectRecordedMedia(clip, {
        tool: async (request) =>
          request.args.includes('-show_frames')
            ? Buffer.from(JSON.stringify({ frames: pts.map((value) => syntheticFrame(value)) }))
            : tool(request),
      }),
      'unsupported_timeline',
    );
  }
});

it('rejects frame-level stereo/HDR transformation metadata instead of dropping it', async () => {
  const base = fakeTool();
  await code(
    inspectRecordedMedia(clip, {
      tool: async (request) => {
        if (!request.args.includes('-show_frames')) return base(request);
        const value = frames();
        Object.assign(value.frames[0] ?? {}, { side_data_list: [{ side_data_type: 'Stereo 3D' }] });
        return Buffer.from(JSON.stringify(value));
      },
    }),
    'unsupported_video',
  );
});

it('rejects frame dimensions or pixel formats changing within the source', async () => {
  const base = fakeTool();
  await code(
    inspectRecordedMedia(clip, {
      tool: async (request) => {
        if (!request.args.includes('-show_frames')) return base(request);
        const value = frames();
        Object.assign(value.frames[1] ?? {}, { width: 192, height: 32 });
        return Buffer.from(JSON.stringify(value));
      },
    }),
    'unsupported_video',
  );
});

it('enforces finite selected range, frame count and decoded-byte budgets before decoder', async () => {
  for (const range of [
    { startSeconds: -1, durationSeconds: 1 },
    { startSeconds: 0, durationSeconds: 0 },
    { startSeconds: Number.NaN, durationSeconds: 1 },
    { startSeconds: 1, durationSeconds: 2 },
    { startSeconds: 0, durationSeconds: 61 },
  ])
    await code(decodeRecordedFrames(clip, range, { tool: fakeTool() }), 'invalid_range');
});

it('refuses mismatched decoded byte count and sanitizes untrusted tool failures', async () => {
  await code(
    decodeRecordedFrames(
      clip,
      { startSeconds: 0, durationSeconds: 2 },
      {
        tool: async (request) =>
          request.tool === 'ffmpeg' ? Buffer.alloc(1) : fakeTool()(request),
      },
    ),
    'decode_failed',
  );
  await code(
    inspectRecordedMedia(clip, {
      tool: async () => {
        throw new Error(`${clip} private-marker`);
      },
    }),
    'tool_failed',
  );
  await code(
    inspectRecordedMedia(clip, { tool: async () => Buffer.from('private-marker') }),
    'invalid_probe',
  );
  await code(inspectRecordedMedia(clip, { tool: async () => Buffer.alloc(65_537) }), 'tool_limit');
});

it('allows only one active intake and child chain per process', async () => {
  let release: (() => void) | undefined;
  let entered: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = inspectRecordedMedia(clip, {
    tool: async (request) => {
      entered?.();
      await gate;
      return fakeTool()(request);
    },
  });
  await ready;
  try {
    await code(inspectRecordedMedia(clip), 'media_busy');
  } finally {
    release?.();
    await pending;
  }
});

for (const [stream, expected] of [
  ['stdout', 'tool_limit'],
  ['stderr', 'tool_limit'],
  ['timeout', 'tool_timeout'],
] as const) {
  it(`kills and waits for its only child on ${stream} budget exhaustion`, async () => {
    let killed = false;
    let closed = false;
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: (signal: string) => {
        assert.equal(signal, 'SIGKILL');
        killed = true;
        setImmediate(() => {
          closed = true;
          child.emit('close', null);
        });
        return true;
      },
    });
    const tool = makeRecordedMediaTool((path, _args, options) => {
      assert.equal(path, '/opt/homebrew/bin/ffprobe');
      assert.equal(options.shell, false);
      assert.deepEqual(options.stdio, ['pipe', 'pipe', 'pipe']);
      if (stream !== 'timeout')
        setImmediate(() => {
          child[stream].write(Buffer.alloc(stream === 'stdout' ? 33 : 16_385));
        });
      return child as unknown as ChildProcessWithoutNullStreams;
    });
    await code(
      tool({
        tool: 'ffprobe',
        args: [],
        source: Buffer.from('synthetic'),
        timeoutMs: 5,
        maxStdoutBytes: 32,
      }),
      expected,
    );
    assert.equal(killed, true);
    assert.equal(closed, true);
  });
}

it('rejects too many probed frames and an excessive RGB selection before decoding', async () => {
  const base = fakeTool();
  await code(
    inspectRecordedMedia(clip, {
      tool: async (request) =>
        request.args.includes('-show_frames')
          ? Buffer.from(
              JSON.stringify({
                frames: Array.from({ length: 61 }, (_, pts) => syntheticFrame(pts, 1)),
              }),
            )
          : base(request),
    }),
    'media_limit',
  );
  let decoded = false;
  await code(
    decodeRecordedFrames(
      clip,
      { startSeconds: 0, durationSeconds: 60 },
      {
        tool: async (request) => {
          if (request.tool === 'ffmpeg') {
            decoded = true;
            assert.fail('no decoder');
          }
          if (request.args.includes('-show_frames'))
            return Buffer.from(
              JSON.stringify({
                frames: Array.from({ length: 60 }, (_, pts) => syntheticFrame(pts, 1, 1280, 720)),
              }),
            );
          const value = metadata();
          Object.assign(value.streams[0] ?? {}, {
            width: 1280,
            height: 720,
            duration_ts: 60,
            nb_frames: '60',
            time_base: '1/1',
          });
          value.format.duration = '60';
          return Buffer.from(JSON.stringify(value));
        },
      },
    ),
    'media_limit',
  );
  assert.equal(decoded, false);
});
