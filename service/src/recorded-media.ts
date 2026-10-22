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
