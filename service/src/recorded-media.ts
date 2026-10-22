import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from 'node:child_process';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';

// Deliberately small whole-clip limits until longer/edited/VFR sources have proof.
const MAX_SOURCE_BYTES = 128 * 1024 * 1024;
const MAX_DECODE_BYTES = 64 * 1024 * 1024;
const MAX_FRAMES = 60;
const MAX_SECONDS = 60;
const MAX_PROBE_BYTES = 65_536;
const MAX_STDERR_BYTES = 16_384;
const TOTAL_MS = 20_000;
const TOOL_PATHS = { ffmpeg: '/opt/homebrew/bin/ffmpeg', ffprobe: '/opt/homebrew/bin/ffprobe' };
const ERROR_CODES = [
  'invalid_input',
  'media_limit',
  'unsupported_container',
  'unsupported_layout',
  'unsupported_edits',
  'external_reference',
  'unsupported_video',
  'unsupported_audio',
  'unsupported_timeline',
  'invalid_probe',
  'invalid_range',
  'tool_failed',
  'tool_limit',
  'tool_timeout',
  'decode_failed',
  'media_busy',
] as const;
type ErrorCode = (typeof ERROR_CODES)[number];

export class RecordedMediaError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode) {
    super(code);
    this.name = 'RecordedMediaError';
    this.code = code;
  }
}
function fail(code: ErrorCode): never {
  throw new RecordedMediaError(code);
}

export type RecordedMediaTool = (request: {
  tool: keyof typeof TOOL_PATHS;
  args: string[];
  source: Buffer;
  timeoutMs: number;
  maxStdoutBytes: number;
}) => Promise<Buffer>;

type CaptureOrigin = {
  value: string | null;
  source: 'none' | 'metadata';
  trust: 'unknown' | 'unverified';
  timezone: 'unknown' | 'missing' | 'explicit';
  status: 'unknown' | 'conflict' | 'unverified';
  sources: string[];
};
type TimeBase = { numerator: number; denominator: number };
export type RecordedMediaInfo = {
  sourceSha256: string;
  videoFrames: number;
  audioTracks: number;
  width: number;
  height: number;
  durationSeconds: number;
  sourceTimeBase: TimeBase;
  sourceTrackIndex: number;
  captureOrigin: CaptureOrigin;
};
type Options = { tool?: RecordedMediaTool };
type Range = { startSeconds: number; durationSeconds: number };
let active = false;

export function isSelectedLocalPath(input: string): boolean {
  return (
    input.length > 0 &&
    input.length <= 4096 &&
    !/^[a-z][a-z0-9+.-]*:/i.test(input) &&
    !input.startsWith('//') &&
    !input.includes('\\') &&
    !Array.from(input).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  );
}

async function readSelectedFile(input: string, deadline: number): Promise<Buffer> {
  if (!isSelectedLocalPath(input)) fail('invalid_input');
  const path = resolve(input);
  try {
    if ((await realpath(path)) !== path) fail('invalid_input');
    const selected = await lstat(path, { bigint: true });
    if (!selected.isFile()) fail('invalid_input');
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await file.stat({ bigint: true });
      if (!before.isFile() || before.dev !== selected.dev || before.ino !== selected.ino)
        fail('invalid_input');
      if (before.size <= 0 || before.size > MAX_SOURCE_BYTES) fail('media_limit');
      // Read exactly the observed length, without readFile's unbounded growth on a changing file.
      const bytes = Buffer.alloc(Number(before.size));
      let offset = 0;
      while (offset < bytes.length) {
        if (performance.now() > deadline) fail('tool_timeout');
        const read = await file.read(
          bytes,
          offset,
          Math.min(1024 * 1024, bytes.length - offset),
          offset,
        );
        if (read.bytesRead === 0) fail('invalid_input');
        offset += read.bytesRead;
      }
      const after = await file.stat({ bigint: true });
      if (performance.now() > deadline) fail('tool_timeout');
      if (
        before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs
      )
        fail('invalid_input');
      return bytes;
    } finally {
      await file.close();
    }
  } catch (error) {
    if (error instanceof RecordedMediaError) throw error;
    fail('invalid_input');
  }
}

// Parse only the local self-contained MOV/MP4 shape we have tested. The decoder receives
// immutable bytes through a pipe and cannot open another file or a network protocol.
function checkContainer(bytes: Buffer): void {
  let boxes = 0;
  let moov = -1;
  let mdat = -1;
  let tracks = 0;
  function walk(start: number, end: number, depth: number, context: string): void {
    if (depth > 12) fail('unsupported_container');
    for (let offset = start; offset < end; ) {
      if (++boxes > 4096 || offset + 8 > end) fail('unsupported_container');
      let size = bytes.readUInt32BE(offset);
      let header = 8;
      if (size === 1) {
        if (offset + 16 > end) fail('unsupported_container');
        const large = bytes.readBigUInt64BE(offset + 8);
        if (large > BigInt(end - offset)) fail('unsupported_container');
        size = Number(large);
        header = 16;
      }
      if (size < header || offset + size > end) fail('unsupported_container');
      const kind = bytes.toString('latin1', offset + 4, offset + 8);
      const body = offset + header;
      const limit = offset + size;
      if (kind === 'edts' || kind === 'elst') fail('unsupported_edits');
      if (['rmra', 'rmda', 'rdrf', 'alis'].includes(kind)) fail('external_reference');
      if (['moof', 'mvex', 'uuid', 'sidx', 'mfra'].includes(kind)) fail('unsupported_layout');
      if (depth === 0) {
        if (!['ftyp', 'moov', 'mdat', 'free', 'skip', 'wide'].includes(kind))
          fail('unsupported_container');
        if (offset === 0 && kind !== 'ftyp') fail('unsupported_container');
        if (kind === 'moov') {
          if (moov !== -1) fail('unsupported_container');
          moov = offset;
        }
        if (kind === 'mdat') {
          if (mdat !== -1) fail('unsupported_layout');
          mdat = offset;
        }
      }
      if (['moov', 'trak', 'mdia', 'minf', 'stbl', 'dinf'].includes(kind)) {
        if (kind === 'trak') tracks++;
        walk(body, limit, depth + 1, kind);
      } else if (kind === 'dref') {
        if (
          body + 8 > limit ||
          bytes.readUInt32BE(body) !== 0 ||
          bytes.readUInt32BE(body + 4) !== 1
        )
          fail('external_reference');
        walk(body + 8, limit, depth + 1, 'dref');
      } else if (context === 'dref') {
        if (kind !== 'url ' || size !== 12 || bytes.readUInt32BE(body) !== 1)
          fail('external_reference');
      } else if (kind === 'stsd') {
        if (
          body + 8 > limit ||
          bytes.readUInt32BE(body) !== 0 ||
          bytes.readUInt32BE(body + 4) !== 1
        )
          fail('unsupported_layout');
        walk(body + 8, limit, depth + 1, 'stsd');
      } else if (context === 'stsd') {
        const video = ['avc1', 'hvc1'].includes(kind);
        if (!video && kind !== 'mp4a') fail('unsupported_layout');
        const prefix = video ? 78 : 28;
        if (body + prefix > limit || bytes.readUInt16BE(body + 6) !== 1) fail('external_reference');
        if (!video && bytes.readUInt16BE(body + 8) !== 0) fail('unsupported_audio');
        walk(body + prefix, limit, depth + 1, 'sample');
      } else if (context === 'sample') {
        if (!['avcC', 'hvcC', 'pasp', 'btrt', 'colr', 'esds', 'fiel'].includes(kind))
          fail('unsupported_layout');
        if (kind === 'fiel' && (size !== 10 || bytes[body] !== 1 || bytes[body + 1] !== 0))
          fail('unsupported_video');
        if (
          kind === 'pasp' &&
          (size !== 16 ||
            bytes.readUInt32BE(body) === 0 ||
            bytes.readUInt32BE(body) !== bytes.readUInt32BE(body + 4))
        )
          fail('unsupported_video');
        if (kind === 'colr' && !['nclc', 'nclx'].includes(bytes.toString('latin1', body, body + 4)))
          fail('unsupported_video');
      }
      offset = limit;
    }
  }
  walk(0, bytes.length, 0, 'root');
  if (moov < 0 || mdat < 0 || tracks < 1 || tracks > 2) fail('unsupported_container');
  if (moov > mdat) fail('unsupported_layout');
}

export function makeRecordedMediaTool(
  start: (
    path: string,
    args: string[],
    options: SpawnOptionsWithoutStdio,
  ) => ChildProcessWithoutNullStreams = spawn,
): RecordedMediaTool {
  return async (request) =>
    new Promise<Buffer>((resolveTool, reject) => {
      const child = start(TOOL_PATHS[request.tool], request.args, {
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { LC_ALL: 'C', AV_LOG_FORCE_NOCOLOR: '1' },
      });
      let failure: ErrorCode | undefined;
      let stdoutBytes = 0;
      let stderrBytes = 0;
      const chunks: Buffer[] = [];
      const stop = (code: ErrorCode) => {
        failure ??= code;
        child.kill('SIGKILL');
      };
      const timer = setTimeout(() => {
        stop('tool_timeout');
      }, request.timeoutMs);
      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > request.maxStdoutBytes) stop('tool_limit');
        else if (!failure) chunks.push(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stderrBytes > MAX_STDERR_BYTES) stop('tool_limit');
      });
      child.stdin.on('error', () => {
        /* A rejecting decoder can close input early. */
      });
      child.on('error', () => {
        failure ??= 'tool_failed';
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (failure || code !== 0) reject(new RecordedMediaError(failure ?? 'tool_failed'));
        else resolveTool(Buffer.concat(chunks, stdoutBytes));
      });
      child.stdin.end(request.source);
    });
}
const runTool = makeRecordedMediaTool();

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid_probe');
  return value as Record<string, unknown>;
}
function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) fail('invalid_probe');
  return value;
}
function timeBase(value: unknown): TimeBase {
  if (typeof value !== 'string' || !/^[1-9]\d{0,8}\/[1-9]\d{0,8}$/.test(value))
    fail('invalid_probe');
  const [numerator, denominator] = value.split('/').map(Number);
  if (!numerator || !denominator) fail('invalid_probe');
  return { numerator, denominator };
}

function captureOrigin(
  streams: Record<string, unknown>[],
  format: Record<string, unknown>,
): CaptureOrigin {
  const claims: string[] = [];
  const sources: string[] = [];
  for (const [index, source] of [format, ...streams].entries()) {
    if (source.tags === undefined) continue;
    const tags = record(source.tags);
    for (const key of ['creation_time', 'com.apple.quicktime.creationdate']) {
      if (tags[key] !== undefined) {
        if (typeof tags[key] !== 'string') fail('invalid_probe');
        claims.push(tags[key]);
        sources.push(`${index === 0 ? 'format' : `stream:${integer(source.index)}`}:${key}`);
      }
    }
  }
  const result: CaptureOrigin = {
    value: null,
    source: claims.length ? 'metadata' : 'none',
    trust: 'unknown',
    timezone: 'unknown',
    status: 'unknown',
    sources,
  };
  if (claims.length === 0) return result;
  const parsed: string[] = [];
  for (const value of claims) {
    const parts =
      /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})?$/.exec(
        value,
      );
    if (!parts) return result;
    const [, year, month, day, hour, minute, second, , offset] = parts;
    const local = `${year}-${month}-${day}T${hour}:${minute}:${second}`;
    const calendar = new Date(`${local}Z`);
    if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 19) !== local)
      return result;
    if (!offset) {
      result.timezone = 'missing';
      return result;
    }
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return result;
    parsed.push(date.toISOString());
  }
  result.timezone = 'explicit';
  if (new Set(parsed).size !== 1) {
    result.status = 'conflict';
    return result;
  }
  result.value = parsed[0] ?? null;
  result.status = 'unverified';
  result.trust = 'unverified';
  return result;
}

const INPUT_ARGS = [
  '-hide_banner',
  '-v',
  'error',
  '-max_alloc',
  '67108864',
  '-max_pixels',
  '921600',
  '-threads',
  '1',
  '-protocol_whitelist',
  'pipe',
  '-format_whitelist',
  'mov',
  '-f',
  'mov',
  '-enable_drefs',
  '0',
  '-use_absolute_path',
  '0',
];

async function intake<T>(
  input: string,
  options: Options,
  operation: (
    source: Buffer,
    call: (tool: keyof typeof TOOL_PATHS, args: string[], max: number) => Promise<Buffer>,
  ) => Promise<T>,
): Promise<T> {
  if (active) fail('media_busy');
  active = true;
  const deadline = performance.now() + TOTAL_MS;
  try {
    const source = await readSelectedFile(input, deadline);
    checkContainer(source);
    const call = async (tool: keyof typeof TOOL_PATHS, args: string[], max: number) => {
      const remaining = deadline - performance.now();
      if (remaining <= 0) fail('tool_timeout');
      try {
        const bytes = await (options.tool ?? runTool)({
          tool,
          args,
          source,
          timeoutMs: Math.min(tool === 'ffmpeg' ? 10_000 : 5000, remaining),
          maxStdoutBytes: max,
        });
        if (performance.now() > deadline) fail('tool_timeout');
        if (!Buffer.isBuffer(bytes) || bytes.length > max) fail('tool_limit');
        return bytes;
      } catch (error) {
        if (error instanceof RecordedMediaError && ERROR_CODES.includes(error.code)) throw error;
        fail('tool_failed');
      }
    };
    return await operation(source, call);
  } finally {
    active = false;
  }
}

async function probe(
  call: (tool: keyof typeof TOOL_PATHS, args: string[], max: number) => Promise<Buffer>,
) {
  async function json(args: string[]) {
    const bytes = await call(
      'ffprobe',
      [...INPUT_ARGS, ...args, '-of', 'json', '-i', 'pipe:0'],
      MAX_PROBE_BYTES,
    );
    try {
      return record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    } catch {
      fail('invalid_probe');
    }
  }
  const metadata = await json([
    '-show_streams',
    '-show_format',
    '-show_entries',
    'stream=index,codec_type,codec_name,codec_tag_string,width,height,pix_fmt,time_base,start_pts,duration_ts,nb_frames,color_transfer,field_order,sample_aspect_ratio,channels,sample_rate:stream_tags=creation_time,com.apple.quicktime.creationdate:stream_side_data:format=format_name,duration:format_tags=creation_time,com.apple.quicktime.creationdate',
  ]);
  if (
    !Array.isArray(metadata.streams) ||
    metadata.streams.length < 1 ||
    metadata.streams.length > 2
  )
    fail('unsupported_video');
  const streams = metadata.streams.map(record);
  const videos = streams.filter((stream) => stream.codec_type === 'video');
  const audio = streams.filter((stream) => stream.codec_type === 'audio');
  if (videos.length !== 1 || audio.length > 1 || videos.length + audio.length !== streams.length)
    fail('unsupported_video');
  const video = videos[0];
  if (!video) fail('unsupported_video');
  if (
    !(
      (video.codec_name === 'h264' && video.codec_tag_string === 'avc1') ||
      (video.codec_name === 'hevc' && video.codec_tag_string === 'hvc1')
    ) ||
    video.pix_fmt !== 'yuv420p' ||
    ![undefined, 'unknown', 'bt709', 'smpte170m', 'iec61966-2-1'].includes(
      video.color_transfer as string | undefined,
    ) ||
    ![undefined, 'unknown', 'progressive'].includes(video.field_order as string | undefined) ||
    ![undefined, '1:1'].includes(video.sample_aspect_ratio as string | undefined) ||
    (video.side_data_list !== undefined &&
      (!Array.isArray(video.side_data_list) || video.side_data_list.length !== 0))
  )
    fail('unsupported_video');
  const width = integer(video.width);
  const height = integer(video.height);
  if (width <= 0 || height <= 0 || width > 1280 || height > 720) fail('media_limit');
  const base = timeBase(video.time_base);
  const durationTicks = integer(video.duration_ts);
  const durationSeconds = (durationTicks * base.numerator) / base.denominator;
  const format = record(metadata.format);
  if (format.format_name !== 'mov,mp4,m4a,3gp,3g2,mj2') fail('unsupported_container');
  if (
    !(durationSeconds > 0 && durationSeconds <= MAX_SECONDS) ||
    typeof format.duration !== 'string' ||
    !/^\d+(?:\.\d+)?$/.test(format.duration) ||
    Number(format.duration) > MAX_SECONDS
  )
    fail('media_limit');
  if (video.start_pts !== 0 || Math.abs(Number(format.duration) - durationSeconds) > 0.000001)
    fail('unsupported_timeline');
  for (const stream of audio) {
    if (
      stream.codec_name !== 'aac' ||
      ![1, 2].includes(integer(stream.channels)) ||
      !['8000', '16000', '22050', '24000', '32000', '44100', '48000'].includes(
        String(stream.sample_rate),
      )
    )
      fail('unsupported_audio');
    if (stream.start_pts !== 0) fail('unsupported_timeline');
    const audioBase = timeBase(stream.time_base);
    const audioTicks = integer(stream.duration_ts);
    // Compare exact source durations across time bases, without rounding or alignment repair.
    if (
      audioTicks <= 0 ||
      BigInt(audioTicks) * BigInt(audioBase.numerator) * BigInt(base.denominator) !==
        BigInt(durationTicks) * BigInt(base.numerator) * BigInt(audioBase.denominator)
    )
      fail('unsupported_timeline');
  }
  const timeline = await json([
    '-select_streams',
    'v:0',
    '-show_frames',
    '-show_entries',
    'frame=pts,duration,color_transfer,width,height,pix_fmt,sample_aspect_ratio,interlaced_frame:frame_side_data=side_data_type',
  ]);
  if (
    !Array.isArray(timeline.frames) ||
    timeline.frames.length < 1 ||
    timeline.frames.length > MAX_FRAMES
  )
    fail('media_limit');
  const frames = timeline.frames.map((value) => {
    const frame = record(value);
    if (
      integer(frame.width) !== width ||
      integer(frame.height) !== height ||
      frame.pix_fmt !== 'yuv420p' ||
      frame.sample_aspect_ratio !== '1:1' ||
      frame.interlaced_frame !== 0
    )
      fail('unsupported_video');
    if (
      ![undefined, 'unknown', 'bt709', 'smpte170m', 'iec61966-2-1'].includes(
        frame.color_transfer as string | undefined,
      )
    )
      fail('unsupported_video');
    if (
      frame.side_data_list !== undefined &&
      (!Array.isArray(frame.side_data_list) ||
        frame.side_data_list.some(
          (side) => record(side).side_data_type !== 'H.26[45] User Data Unregistered SEI message',
        ))
    )
      fail('unsupported_video');
    return { pts: integer(frame.pts), duration: integer(frame.duration) };
  });
  const step = frames[0]?.duration;
  if (
    !step ||
    step <= 0 ||
    String(frames.length) !== video.nb_frames ||
    step * frames.length !== durationTicks ||
    frames.some((frame, index) => frame.pts !== index * step || frame.duration !== step)
  )
    fail('unsupported_timeline');
  const info: Omit<RecordedMediaInfo, 'sourceSha256'> = {
    videoFrames: frames.length,
    audioTracks: audio.length,
    width,
    height,
    durationSeconds,
    sourceTimeBase: base,
    sourceTrackIndex: integer(video.index),
    captureOrigin: captureOrigin(streams, format),
  };
  return { info, frames };
}

export async function inspectRecordedMedia(
  input: string,
  options: Options = {},
): Promise<RecordedMediaInfo> {
  return intake(input, options, async (source, call) => ({
    ...(await probe(call)).info,
    sourceSha256: createHash('sha256').update(source).digest('hex'),
  }));
}

export async function decodeRecordedFrames(input: string, range: Range, options: Options = {}) {
  if (
    !Number.isFinite(range.startSeconds) ||
    !Number.isFinite(range.durationSeconds) ||
    range.startSeconds < 0 ||
    range.durationSeconds <= 0 ||
    range.durationSeconds > MAX_SECONDS
  )
    fail('invalid_range');
  return intake(input, options, async (source, call) => {
    const { info, frames } = await probe(call);
    const end = range.startSeconds + range.durationSeconds;
    if (end > info.durationSeconds) fail('invalid_range');
    const chosen = frames.filter((frame) => {
      const seconds = (frame.pts * info.sourceTimeBase.numerator) / info.sourceTimeBase.denominator;
      return seconds >= range.startSeconds && seconds < end;
    });
    if (chosen.length === 0 || chosen.length > MAX_FRAMES) fail('invalid_range');
    const frameBytes = info.width * info.height * 3;
    const total = frameBytes * chosen.length;
    if (total > MAX_DECODE_BYTES) fail('media_limit');
    const expression = chosen.map((frame) => `eq(pts\\,${frame.pts})`).join('+');
    const rgb = await call(
      'ffmpeg',
      [
        ...INPUT_ARGS,
        '-nostdin',
        '-noautorotate',
        '-copyts',
        '-i',
        'pipe:0',
        '-map',
        '0:v:0',
        '-an',
        '-sn',
        '-dn',
        '-vf',
        `select=${expression}`,
        '-fps_mode',
        'passthrough',
        '-frames:v',
        String(chosen.length),
        '-threads',
        '1',
        '-filter_threads',
        '1',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgb24',
        'pipe:1',
      ],
      total,
    );
    if (rgb.length !== total) fail('decode_failed');
    return {
      ...info,
      sourceSha256: createHash('sha256').update(source).digest('hex'),
      frames: chosen.map((frame, index) => ({
        sourcePts: frame.pts,
        sourceDuration: frame.duration,
        rgb: rgb.subarray(index * frameBytes, (index + 1) * frameBytes),
      })),
    };
  });
}
