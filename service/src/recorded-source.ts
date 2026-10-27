/**
 * Recorded footage the person brought to this Mac: imported once by the operator, shown to the
 * headset as a still, and booped like a capture. Every frame is an exact frame of the file, never
 * live, and its capture time is the file's own claim (unverified) or unknown. The journal keeps the
 * file's SHA-256 and opaque ids; never its name, its path, a location or its audio.
 */
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { constants, existsSync, mkdirSync } from 'node:fs';
import { chmod, lstat, mkdtemp, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { z } from 'zod';
import { BoopyError } from './boopy.ts';
import type { Actor } from './events.ts';
import type { Interpreter } from './interpret/interpreter.ts';
import type { Journal, MediaStore, Recorded } from './journal.ts';
import { type CaptureOrigin, captureOrigin, parseCaptureClaims } from './recorded-media.ts';
import { interpreterNouns, type OutlinedFrame, outlineFrames } from './recorded-outlines.ts';

const MAX_SOURCE_BYTES = 4 * 1024 ** 3;
const MAX_SOURCE_SECONDS = 30 * 60;
const MAX_WINDOW_SECONDS = 60;
const MAX_FRAMES = 600;
const MAX_STILL_BYTES = 2 * 1024 * 1024;
const LONG_EDGE = 1280;
/** The headset shows a recorded frame across about 100 degrees, so it gets a sharper rendition. */
const DISPLAY_LONG_EDGE = 2560;
const MAX_DISPLAY_BYTES = 4 * 1024 * 1024;
const FFPROBE = '/opt/homebrew/bin/ffprobe';
const FFMPEG = '/opt/homebrew/bin/ffmpeg';
/** The diagonal a 35 mm-equivalent focal length is defined against (a 36 by 24 mm frame). */
const FULL_FRAME_DIAGONAL_MM = Math.hypot(36, 24);
const FOCAL_TAG = 'com.apple.quicktime.camera.focal_length.35mm_equivalent';
/** The only tags the remux may keep: the container's own, none from the recording. */
const CONTAINER_TAGS = ['major_brand', 'minor_version', 'compatible_brands'];
const STREAM_TAGS = ['language', 'handler_name'];
const VIDEO = ['mov', 'mp4', 'm4v'] as const;
const PHOTO = ['heic', 'heif', 'jpg', 'jpeg', 'png'] as const;

export const RecordingId = z.string().regex(/^rec_[a-f0-9]{32}$/);
export const RecordedFrameId = z.string().regex(/^rfr_[a-f0-9]{32}$/);

/** Which frames of a video to keep: every step, evenly spaced stills, or chosen moments. */
export const Sampling = z.union([
  z.strictObject({
    mode: z.literal('every'),
    seconds: z
      .number()
      .min(1 / 15)
      .max(MAX_WINDOW_SECONDS),
    startSeconds: z.number().min(0).optional(),
    durationSeconds: z.number().positive().max(MAX_WINDOW_SECONDS).optional(),
  }),
  z.strictObject({
    mode: z.literal('stills'),
    count: z.number().int().min(1).max(60),
    startSeconds: z.number().min(0).optional(),
    durationSeconds: z.number().positive().optional(),
  }),
  z.strictObject({
    mode: z.literal('at'),
    seconds: z.array(z.number().min(0)).min(1).max(60),
  }),
]);
export type Sampling = z.infer<typeof Sampling>;

export const ImportRequest = z.strictObject({
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  extension: z.enum([...VIDEO, ...PHOTO]),
  sampling: Sampling.optional(),
});
export type ImportRequest = z.infer<typeof ImportRequest>;

export const ShowRequest = z.strictObject({
  recordingId: RecordingId,
  frameId: RecordedFrameId.optional(),
  atSeconds: z.number().min(0).optional(),
});

/** One kept frame: its exact time in the file (null for a photo) and its still. */
export interface RecordedFrame {
  readonly frameId: string;
  readonly seconds: number | null;
  readonly time: { readonly value: number; readonly timescale: number } | null;
  readonly frameSha256: string;
  readonly width: number;
  readonly height: number;
}

interface Imported {
  readonly recordingId: string;
  readonly sourceSha256: string;
  readonly kind: 'video' | 'photo';
  readonly bytes: number;
  /** The upright still size every frame of this recording has. */
  readonly width: number;
  readonly height: number;
  readonly durationSeconds: number | null;
  readonly hdr: boolean;
  /** Clockwise quarter turns the file asks for (video) or its EXIF orientation (photo). */
  readonly rotation: number;
  readonly orientation: number;
  readonly sampling: Sampling | null;
  readonly captureOrigin: CaptureOrigin;
  readonly frames: readonly RecordedFrame[];
}

interface Envelope<Type extends string, Data> {
  readonly type: Type;
  readonly session: string;
  readonly actor: Actor;
  readonly data: Data;
}

/** The operator holds the connector token, and the journal records them as the person. */
/** One outline run over a recording's frames: every outline stays proposed and on its frame. */
interface OutlinesMade {
  readonly recordingId: string;
  /** The scene worker that placed the outlines. */
  readonly provider: string;
  readonly model: string;
  /** Nouns the local interpreter proposed for this recording: its proposals, not facts. */
  readonly proposedNouns: readonly string[];
  readonly nounModel: { readonly provider: string; readonly model: string };
  readonly frames: readonly OutlinedFrame[];
  readonly failed: readonly string[];
  readonly wallMs: number;
}

/** The sharper stills the headset shows; the model, gaze crop and outlines keep the 1280 stills. */
interface DisplayMade {
  readonly recordingId: string;
  readonly longEdge: number;
  readonly frames: readonly {
    readonly frameId: string;
    readonly displaySha256: string;
    readonly width: number;
    readonly height: number;
  }[];
}

/** The recording for playback: its video alone, H.264 in standard range, no audio, no tag. */
interface VideoMade {
  readonly recordingId: string;
  readonly videoSha256: string;
  readonly bytes: number;
  readonly width: number;
  readonly height: number;
  /** Frames over duration: the average, since a recording's frame times may vary. */
  readonly frameRate: number | null;
}

/**
 * Where the picture's edges were from the capturing camera's forward axis: the tangents of the
 * angles to its left, right, top and bottom edges, all positive (a rectilinear picture).
 */
export const Tangents = z.strictObject({
  tanLeft: z.number().positive().max(20),
  tanRight: z.number().positive().max(20),
  tanUp: z.number().positive().max(20),
  tanDown: z.number().positive().max(20),
});
const ProfileName = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
/** A projection someone measured for the recording device, kept as that. */
export const MeasuredProjection = Tangents.extend({
  profile: ProfileName,
  /** Whether where the picture sits around the forward axis was measured or inferred. */
  centring: z.enum(['measured', 'inferred']),
  /** The profile's other measured shape, kept beside it (for example the square capture). */
  reference: Tangents.extend({ profile: ProfileName }).optional(),
});
interface ProjectionSet extends z.infer<typeof Tangents> {
  readonly recordingId: string;
  readonly source: 'lens-tag' | 'measured-device-profile';
  readonly profile: string | null;
  /** A lens tag gives no optical centre, so a centred picture is assumed. */
  readonly centring: 'measured' | 'inferred' | 'assumed';
  readonly reference?: z.infer<typeof MeasuredProjection>['reference'];
}

export type RecordedEvent =
  | Envelope<'recorded.source.imported', Imported>
  | Envelope<'recorded.scene.shown', { readonly recordingId: string; readonly frameId: string }>
  | Envelope<'recorded.scene.cleared', { readonly recordingId: string }>
  | Envelope<'recorded.outlines.made', OutlinesMade>
  | Envelope<'recorded.display.made', DisplayMade>
  | Envelope<'recorded.video.made', VideoMade>
  | Envelope<'recorded.projection.set', ProjectionSet>;

/** What makes outlines for a recording: the local scene worker and the local interpreter. */
export interface Outliner {
  readonly scene: {
    readonly provider: string;
    readonly model: string;
    observe(jpeg: Buffer, signal?: AbortSignal, nouns?: readonly string[]): Promise<unknown>;
  };
  readonly interpreter: Interpreter;
}

export interface RecordingSummary {
  readonly recordingId: string;
  readonly kind: 'video' | 'photo';
  readonly frames: number;
  readonly width: number;
  readonly height: number;
  readonly durationSeconds: number | null;
  readonly captureTime: CaptureOrigin['status'];
  readonly reused: boolean;
  /** Frames with outlines from the latest run, null before any; running while one is under way. */
  readonly outlines: { readonly running: boolean; readonly frames: number | null };
  /** Frames with a display rendition, null before any; running while one is being made. */
  readonly display: { readonly running: boolean; readonly frames: number | null };
  /** Whether the playback video is made, and where the projection came from, if anywhere. */
  readonly video: boolean;
  readonly projection: ProjectionSet['source'] | null;
}

export interface SceneView {
  readonly recordingId: string;
  readonly frameId: string;
  readonly kind: 'video' | 'photo';
  readonly width: number;
  readonly height: number;
  readonly sourceTimeSeconds: number | null;
  /** The clip's length; null for a photo. */
  readonly durationSeconds: number | null;
  /** The recording to play, as it was captured; frames[].seconds are times in it. Null for a photo. */
  readonly video: {
    readonly url: string;
    readonly sha256: string;
    readonly width: number;
    readonly height: number;
    readonly durationSeconds: number | null;
    readonly frameRate: number | null;
  } | null;
  readonly projection: Omit<ProjectionSet, 'recordingId' | 'reference'> | null;
  readonly capturedAt: { readonly value: string | null; readonly trust: 'unknown' | 'unverified' };
  readonly frameSha256: string;
  readonly frames: readonly { frameId: string; seconds: number | null; frameSha256: string }[];
}

/** Where a recorded observation's still came from: the recording, its frame and the file. */
export interface RecordedObservation {
  readonly recordingId: string;
  readonly frameId: string;
  readonly sourceSha256: string;
  /** The frame's time in the file; null for a photo. */
  readonly seconds: number | null;
}

/** What a turn on a recorded frame observes: the stored still and where it came from. */
export interface ResolvedFrame {
  readonly jpeg: Buffer;
  readonly frameSha256: string;
  readonly width: number;
  readonly height: number;
  readonly capturedAt: string | null;
  readonly recorded: RecordedObservation;
}

const refuse = (status: number, code: string, message: string): never => {
  throw new BoopyError(status, code, message);
};
const invalid = (message: string): never => refuse(400, 'recorded_invalid', message);

/**
 * A journal that already holds a live capture is not one to bring footage into: recorded and
 * live views stay apart, so a recorded scene runs on its own data folder.
 */
export function assertNoLiveCaptures(journal: Journal): void {
  for (const event of journal.withTypePrefix('observation.recorded'))
    if (event.type === 'observation.recorded' && event.data.recorded === undefined)
      throw new Error('This data folder holds a live capture. Use a separate one for recordings.');
}

type Helper = (args: string[], timeoutMs: number) => Promise<Record<string, unknown>>;

/** Runs the still helper with a bounded answer; its own error codes are never shown as-is. */
function helperAt(binary: string): Helper {
  return (args, timeoutMs) =>
    new Promise((resolve, reject) => {
      const child = spawn(binary, args, {
        shell: false,
        stdio: ['ignore', 'pipe', 'ignore'],
        env: { LC_ALL: 'C' },
      });
      const chunks: Buffer[] = [];
      let size = 0;
      const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
      child.stdout.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 4 * 1024 * 1024) child.kill('SIGKILL');
        else chunks.push(chunk);
      });
      child.on('error', () => undefined);
      child.on('close', (code) => {
        clearTimeout(timer);
        let answer: unknown;
        try {
          answer = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          answer = null;
        }
        if (code === 0 && answer !== null && typeof answer === 'object' && !Array.isArray(answer))
          resolve(answer as Record<string, unknown>);
        else
          reject(
            new BoopyError(422, 'recorded_decode_failed', 'Boopy could not read frames from it.'),
          );
      });
    });
}

/** A fixed media tool with an argument array and a deadline: its bounded stdout, or null. */
function runTool(file: string, args: string[], timeoutMs: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const child = spawn(file, args, {
      shell: false,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { LC_ALL: 'C' },
    });
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 65_536) child.kill('SIGKILL');
      else chunks.push(chunk);
    });
    child.on('error', () => undefined);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 && size <= 65_536 ? Buffer.concat(chunks) : null);
    });
  });
}

type TagProbe = { format?: Record<string, unknown>; streams?: Record<string, unknown>[] };

/** The named tags of a stored file, asked for by name so no other tag value is ever read. */
async function probeTags(path: string, entries: string): Promise<TagProbe | null> {
  const output = await runTool(
    FFPROBE,
    [
      ...['-v', 'error', '-protocol_whitelist', 'file', '-format_whitelist', 'mov'],
      ...['-enable_drefs', '0', '-use_absolute_path', '0', '-show_entries', entries],
      ...['-of', 'json', '-i', path],
    ],
    10_000,
  );
  try {
    return output === null ? null : (JSON.parse(output.toString('utf8')) as TagProbe);
  } catch {
    return null;
  }
}

/** The file's own capture-date tags. */
async function videoDates(path: string): Promise<CaptureOrigin> {
  const probe = await probeTags(
    path,
    'format_tags=creation_time,com.apple.quicktime.creationdate:stream=index:stream_tags=creation_time,com.apple.quicktime.creationdate',
  );
  // An unreadable answer is no claim at all, never a guessed time.
  return probe === null
    ? parseCaptureClaims([])
    : captureOrigin(probe.streams ?? [], probe.format ?? {});
}

/** The 35 mm-equivalent focal length a video's camera wrote, by that one tag's name, or null. */
async function videoFocalLength(path: string): Promise<number | null> {
  const probe = await probeTags(path, `format_tags=${FOCAL_TAG}:stream_tags=${FOCAL_TAG}`);
  for (const tags of [
    probe?.format?.tags,
    ...(probe?.streams ?? []).map((stream) => stream.tags),
  ]) {
    const value = Number((tags as Record<string, unknown> | undefined)?.[FOCAL_TAG]);
    if (Number.isFinite(value) && value >= 1 && value <= 2000) return value;
  }
  return null;
}

/**
 * The projection a 35 mm-equivalent focal length gives an upright picture of this shape, centred:
 * the equivalent is defined on a 36 by 24 mm frame's diagonal, which the picture's diagonal takes.
 */
export function lensProjection(focal35: number, width: number, height: number) {
  const half = FULL_FRAME_DIAGONAL_MM / (2 * focal35) / Math.hypot(width, height);
  const tangent = (value: number) => Math.round(value * 1e4) / 1e4;
  return {
    tanLeft: tangent(half * width),
    tanRight: tangent(half * width),
    tanUp: tangent(half * height),
    tanDown: tangent(half * height),
  };
}

/** EXIF DateTimeOriginal with its own offset and fraction; the GPS block is never read. */
function photoDates(probe: Record<string, unknown>): CaptureOrigin {
  const date = probe.dateTimeOriginal;
  if (typeof date !== 'string') return parseCaptureClaims([]);
  const parts = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}:\d{2}:\d{2})$/.exec(date);
  const subsec = typeof probe.subsecTimeOriginal === 'string' ? probe.subsecTimeOriginal : '';
  const offset = typeof probe.offsetTimeOriginal === 'string' ? probe.offsetTimeOriginal : '';
  const value = parts
    ? `${parts[1]}-${parts[2]}-${parts[3]}T${parts[4]}${/^\d{1,9}$/.test(subsec) ? `.${subsec}` : ''}${offset}`
    : date;
  return parseCaptureClaims([{ source: 'exif:DateTimeOriginal', value }]);
}

const number = (value: unknown, check: (n: number) => boolean = () => true): number =>
  typeof value === 'number' && Number.isFinite(value) && check(value)
    ? value
    : refuse(422, 'recorded_decode_failed', 'Boopy could not read frames from it.');

/** The frame shown at a moment: the last one that starts at or before it. */
function shownAt(times: readonly number[], seconds: number): number {
  let low = 0;
  let high = times.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if ((times[middle] as number) <= seconds + 1e-9) low = middle;
    else high = middle - 1;
  }
  return low;
}

/** Which of the file's frames the sampling keeps, as indexes in time order. */
function choose(times: readonly number[], duration: number, sampling: Sampling): number[] {
  const moments: number[] = [];
  if (sampling.mode === 'at') {
    for (const seconds of sampling.seconds) {
      if (seconds >= duration) invalid('A chosen moment is past the end of the recording.');
      moments.push(seconds);
    }
  } else {
    const start = sampling.startSeconds ?? 0;
    const length = sampling.durationSeconds ?? duration - start;
    if (start >= duration || start + length > duration + 1e-6)
      invalid('The window is outside the recording.');
    if (sampling.mode === 'every') {
      if (length > MAX_WINDOW_SECONDS + 1e-6)
        refuse(400, 'recorded_window_required', 'Choose a window of at most 60 seconds.');
      for (let step = 0; start + step * sampling.seconds < start + length - 1e-9; step++)
        moments.push(start + step * sampling.seconds);
    } else
      for (let step = 0; step < sampling.count; step++)
        moments.push(start + (step * length) / sampling.count);
  }
  const chosen = [...new Set(moments.map((moment) => shownAt(times, moment)))].sort(
    (a, b) => a - b,
  );
  if (chosen.length > MAX_FRAMES) invalid('That keeps more than 600 frames. Sample less often.');
  return chosen;
}

/** Re-encodes a helper still with sharp, which keeps no metadata, and checks that none is left. */
async function cleanStill(
  bytes: Buffer,
  longEdge = LONG_EDGE,
  maxBytes = MAX_STILL_BYTES,
): Promise<{ jpeg: Buffer; width: number; height: number }> {
  const jpeg = await sharp(bytes, { limitInputPixels: longEdge * longEdge })
    .jpeg({ quality: 85 })
    .toBuffer();
  const metadata = await sharp(jpeg).metadata();
  if (
    metadata.format !== 'jpeg' ||
    metadata.width === undefined ||
    metadata.height === undefined ||
    Math.max(metadata.width, metadata.height) > longEdge ||
    jpeg.length > maxBytes ||
    metadata.exif !== undefined ||
    metadata.icc !== undefined ||
    metadata.xmp !== undefined ||
    metadata.iptc !== undefined
  )
    refuse(422, 'recorded_decode_failed', 'Boopy could not make a clean still from it.');
  return { jpeg, width: metadata.width as number, height: metadata.height as number };
}

const opaque = (prefix: 'rec' | 'rfr') => `${prefix}_${randomBytes(16).toString('hex')}`;
const round = (seconds: number) => Math.round(seconds * 1e6) / 1e6;

/** The recordings on this Mac and the one the headset is shown, rebuilt from the journal. */
export class RecordedScenes {
  readonly #journal: Journal;
  readonly #media: MediaStore;
  readonly #directory: string;
  readonly #helper: Helper;
  readonly #now: () => Date;
  readonly #recordings = new Map<string, Imported>();
  #shown: { recordingId: string; frameId: string } | null = null;
  #busy = false;
  readonly #outlines = new Map<string, OutlinesMade>();
  readonly #outlining = new Set<string>();
  readonly #display = new Map<string, Map<string, DisplayMade['frames'][number]>>();
  readonly #videos = new Map<string, VideoMade>();
  readonly #projection = new Map<string, ProjectionSet>();
  readonly #displaying = new Set<string>();
  readonly #outliner: Outliner | undefined;

  constructor(options: {
    readonly journal: Journal;
    readonly media: MediaStore;
    /** The private folder the operator's copies are placed in, named by their SHA-256. */
    readonly directory: string;
    /** The built still helper (service/tools/recorded). */
    readonly helper: string;
    readonly now?: () => Date;
    /** Off when the local scene worker is not running; the recordings still work without it. */
    readonly outliner?: Outliner;
  }) {
    this.#journal = options.journal;
    this.#media = options.media;
    this.#directory = options.directory;
    this.#helper = helperAt(options.helper);
    this.#now = options.now ?? (() => new Date());
    this.#outliner = options.outliner;
    mkdirSync(this.#directory, { recursive: true, mode: 0o700 });
    for (const event of options.journal.withTypePrefix('recorded.')) this.#apply(event);
  }

  #apply(event: Recorded): void {
    if (event.type === 'recorded.source.imported')
      this.#recordings.set(event.data.recordingId, event.data);
    else if (event.type === 'recorded.scene.shown') this.#shown = { ...event.data };
    else if (event.type === 'recorded.scene.cleared') this.#shown = null;
    else if (event.type === 'recorded.outlines.made')
      this.#outlines.set(event.data.recordingId, event.data);
    else if (event.type === 'recorded.video.made')
      this.#videos.set(event.data.recordingId, event.data);
    else if (event.type === 'recorded.projection.set')
      this.#projection.set(event.data.recordingId, event.data);
    else if (event.type === 'recorded.display.made')
      this.#display.set(
        event.data.recordingId,
        new Map(event.data.frames.map((frame) => [frame.frameId, frame])),
      );
  }

  #record(event: RecordedEvent): void {
    this.#apply(
      this.#journal.append(event, randomBytes(16).toString('hex'), this.#now().toISOString()),
    );
  }

  /** The source file in the store, checked against its name before anything reads it. */
  async #source(request: ImportRequest): Promise<{ path: string; bytes: number }> {
    const path = join(this.#directory, `${request.sha256}.${request.extension}`);
    const missing = () =>
      refuse(404, 'recorded_source_missing', 'Put the file in the recording store first.');
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(path);
      if (
        (await realpath(path)) !==
        join(await realpath(this.#directory), `${request.sha256}.${request.extension}`)
      )
        missing();
    } catch (error) {
      if (error instanceof BoopyError) throw error;
      return missing();
    }
    if (!info.isFile()) missing();
    if (info.size <= 0 || info.size > MAX_SOURCE_BYTES)
      refuse(413, 'recorded_limit', 'Recordings are at most 4 GiB.');
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const hash = createHash('sha256');
      for await (const chunk of file.createReadStream({ autoClose: false }))
        hash.update(chunk as Buffer);
      if (hash.digest('hex') !== request.sha256)
        refuse(409, 'recorded_sha_mismatch', 'The stored file does not match its SHA-256.');
    } finally {
      await file.close();
    }
    return { path, bytes: Number(info.size) };
  }

  async importSource(input: unknown): Promise<RecordingSummary> {
    const parsed = ImportRequest.safeParse(input);
    if (!parsed.success) return invalid('Name a stored file by its SHA-256 and kind.');
    const request = parsed.data;
    const kind = (VIDEO as readonly string[]).includes(request.extension) ? 'video' : 'photo';
    if (kind === 'photo' && request.sampling !== undefined)
      invalid('A photo is one frame; sampling is for video.');
    const sampling: Sampling | null =
      kind === 'photo' ? null : (request.sampling ?? { mode: 'every', seconds: 0.1 });
    const known = [...this.#recordings.values()].find(
      (recording) =>
        recording.sourceSha256 === request.sha256 &&
        JSON.stringify(recording.sampling) === JSON.stringify(sampling),
    );
    if (known) return this.#summary(known, true);
    if (this.#busy) refuse(409, 'recorded_busy', 'Another import is still running.');
    this.#busy = true;
    let work: string | null = null;
    try {
      const { path, bytes } = await this.#source(request);
      const probe = await this.#helper(
        [kind === 'video' ? 'probe-video' : 'probe-photo', path],
        60_000,
      );
      const width = number(probe.width, (n) => n > 0 && n <= 16384);
      const height = number(probe.height, (n) => n > 0 && n <= 16384);
      work = await mkdtemp(join(this.#directory, '.work-'));
      await chmod(work, 0o700);
      let frames: { seconds: number | null; time: RecordedFrame['time'] }[];
      let durationSeconds: number | null = null;
      let origin: CaptureOrigin;
      let answer: Record<string, unknown>;
      if (kind === 'video' && sampling !== null) {
        durationSeconds = number(probe.durationSeconds, (n) => n > 0);
        if (durationSeconds > MAX_SOURCE_SECONDS)
          refuse(413, 'recorded_limit', 'Recordings are at most 30 minutes.');
        if (request.sampling === undefined && durationSeconds > MAX_WINDOW_SECONDS + 1e-6)
          refuse(400, 'recorded_window_required', 'Choose a window of at most 60 seconds.');
        const timescale = number(probe.timescale, (n) => Number.isInteger(n) && n > 0);
        if (!Array.isArray(probe.frames) || probe.frames.length === 0)
          refuse(422, 'recorded_decode_failed', 'Boopy could not read frames from it.');
        const values = (probe.frames as unknown[]).map((value) =>
          number(value, Number.isSafeInteger),
        );
        const seconds = values.map((value) => value / timescale);
        const chosen = choose(seconds, durationSeconds, sampling);
        frames = chosen.map((index) => ({
          seconds: round(seconds[index] as number),
          time: { value: values[index] as number, timescale },
        }));
        origin = await videoDates(path);
        answer = await this.#helper(
          [
            'stills-video',
            path,
            work,
            String(LONG_EDGE),
            ...frames.map((frame) => `${frame.time?.value}/${timescale}`),
          ],
          10 * 60_000,
        );
      } else {
        frames = [{ seconds: null, time: null }];
        origin = photoDates(probe);
        answer = await this.#helper(['still-photo', path, work, String(LONG_EDGE)], 60_000);
      }
      if (!Array.isArray(answer.stills) || answer.stills.length !== frames.length)
        refuse(422, 'recorded_decode_failed', 'Boopy could not read frames from it.');
      const kept: RecordedFrame[] = [];
      for (const [index, frame] of frames.entries()) {
        const still = await cleanStill(await readFile(join(work, `${index}.jpg`)));
        kept.push({
          frameId: opaque('rfr'),
          seconds: frame.seconds,
          time: frame.time,
          frameSha256: this.#media.put(still.jpeg, 'jpg'),
          width: still.width,
          height: still.height,
        });
      }
      const first = kept[0] as RecordedFrame;
      const imported: Imported = {
        recordingId: opaque('rec'),
        sourceSha256: request.sha256,
        kind,
        bytes,
        width: first.width,
        height: first.height,
        durationSeconds: durationSeconds === null ? null : round(durationSeconds),
        hdr: probe.hdr === true,
        rotation:
          kind === 'video' ? number(probe.rotation, (n) => [0, 90, 180, 270].includes(n)) : 0,
        orientation: kind === 'photo' ? number(probe.orientation, (n) => n >= 1 && n <= 8) : 1,
        sampling,
        captureOrigin: origin,
        frames: kept,
      };
      // The stills must keep the upright shape the file asks for, or a gaze would land elsewhere.
      if (width > height !== first.width > first.height)
        refuse(422, 'recorded_decode_failed', 'Boopy could not read frames from it.');
      this.#record({
        type: 'recorded.source.imported',
        session: imported.recordingId,
        actor: 'person',
        data: imported,
      });
      // The headset's sharper renditions; without them it is shown the stills, so a failure here
      // leaves the import as it is.
      await this.#prepare(imported, path);
      return this.#summary(imported, false);
    } finally {
      this.#busy = false;
      if (work !== null) await rm(work, { recursive: true, force: true });
    }
  }

  recordings(): RecordingSummary[] {
    return [...this.#recordings.values()].map((recording) => this.#summary(recording, false));
  }

  #summary(recording: Imported, reused: boolean): RecordingSummary {
    return {
      ...summary(recording, reused),
      display: {
        running: this.#displaying.has(recording.recordingId),
        frames: this.#display.get(recording.recordingId)?.size ?? null,
      },
      video: this.#videos.has(recording.recordingId),
      projection: this.#projection.get(recording.recordingId)?.source ?? null,
      outlines: {
        running: this.#outlining.has(recording.recordingId),
        frames: this.#outlines.get(recording.recordingId)?.frames.length ?? null,
      },
    };
  }

  /**
   * Makes the headset's sharper renditions of every kept frame, long side 2560 or the source's own
   * size, from the original in the store: upright, standard range, no metadata. One helper job at a
   * time; journaled once as recorded.display.made.
   */
  async #makeDisplay(recording: Imported, path: string): Promise<void> {
    const work = await mkdtemp(join(this.#directory, '.work-'));
    try {
      await chmod(work, 0o700);
      const timed = recording.frames.filter((frame) => frame.time !== null);
      const answer =
        recording.kind === 'video'
          ? await this.#helper(
              [
                'stills-video',
                path,
                work,
                String(DISPLAY_LONG_EDGE),
                ...timed.map((frame) => `${frame.time?.value}/${frame.time?.timescale}`),
              ],
              10 * 60_000,
            )
          : await this.#helper(['still-photo', path, work, String(DISPLAY_LONG_EDGE)], 60_000);
      if (!Array.isArray(answer.stills) || answer.stills.length !== recording.frames.length)
        refuse(422, 'recorded_decode_failed', 'Boopy could not read frames from it.');
      const frames: DisplayMade['frames'][number][] = [];
      for (const [index, frame] of recording.frames.entries()) {
        const still = await cleanStill(
          await readFile(join(work, `${index}.jpg`)),
          DISPLAY_LONG_EDGE,
          MAX_DISPLAY_BYTES,
        );
        // The rendition must keep the still's shape, so normalized points mean the same place.
        if (Math.abs(still.width / still.height - frame.width / frame.height) > 0.01)
          refuse(422, 'recorded_decode_failed', 'Boopy could not read frames from it.');
        frames.push({
          frameId: frame.frameId,
          displaySha256: this.#media.put(still.jpeg, 'jpg'),
          width: still.width,
          height: still.height,
        });
      }
      this.#record({
        type: 'recorded.display.made',
        session: recording.recordingId,
        actor: 'person',
        data: { recordingId: recording.recordingId, longEdge: DISPLAY_LONG_EDGE, frames },
      });
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }

  /**
   * Everything the headset needs beyond the stills, each made once and each optional: the display
   * renditions, the playback video, and the field of view from a lens tag. One failing part leaves
   * the others and the recording as they are.
   */
  async #prepare(recording: Imported, path: string): Promise<void> {
    if (!this.#display.has(recording.recordingId))
      await this.#makeDisplay(recording, path).catch(() => undefined);
    if (recording.kind === 'video' && !this.#videos.has(recording.recordingId))
      await this.#makeVideo(recording, path).catch(() => undefined);
    if (!this.#projection.has(recording.recordingId)) {
      const focal =
        recording.kind === 'video'
          ? await videoFocalLength(path)
          : await this.#helper(['probe-photo', path], 60_000).then(
              (probe) => (typeof probe.focalLength35mm === 'number' ? probe.focalLength35mm : null),
              () => null,
            );
      if (focal !== null && focal >= 1 && focal <= 2000)
        this.#record({
          type: 'recorded.projection.set',
          session: recording.recordingId,
          actor: 'person',
          data: {
            recordingId: recording.recordingId,
            source: 'lens-tag',
            profile: null,
            centring: 'assumed',
            ...lensProjection(focal, recording.width, recording.height),
          },
        });
    }
  }

  /**
   * The recording for playback: the helper writes its video alone as H.264 in standard range,
   * every frame at its own time, then ffmpeg copies it once more with no tag at all and the index
   * first. A tag left beyond the container's own refuses it. Stored 0600, named by its SHA-256.
   */
  async #makeVideo(recording: Imported, path: string): Promise<void> {
    const work = await mkdtemp(join(this.#directory, '.work-'));
    try {
      await chmod(work, 0o700);
      const raw = join(work, 'raw.mp4');
      const out = join(work, 'out.mp4');
      const answer = await this.#helper(['export-video', path, raw], 10 * 60_000);
      const width = number(answer.width, (n) => n > 0 && n <= 16384);
      const height = number(answer.height, (n) => n > 0 && n <= 16384);
      const written = number(answer.frames, (n) => Number.isInteger(n) && n > 0);
      const copied = await runTool(
        FFMPEG,
        [
          ...['-v', 'error', '-nostdin', '-protocol_whitelist', 'file', '-i', raw],
          ...['-map', '0:v:0', '-c', 'copy', '-map_metadata', '-1', '-map_metadata:s', '-1'],
          ...[
            '-fflags',
            '+bitexact',
            '-flags:v',
            '+bitexact',
            '-movflags',
            '+faststart',
            '-y',
            out,
          ],
        ],
        120_000,
      );
      const tags = copied === null ? null : await probeTags(out, 'format_tags:stream_tags');
      if (
        tags === null ||
        !Object.keys(tags.format?.tags ?? {}).every((key) => CONTAINER_TAGS.includes(key)) ||
        !(tags.streams ?? []).every((stream) =>
          Object.keys((stream.tags as object | undefined) ?? {}).every((key) =>
            STREAM_TAGS.includes(key),
          ),
        )
      )
        refuse(422, 'recorded_decode_failed', 'Boopy could not make a clean video from it.');
      const hash = createHash('sha256');
      let bytes = 0;
      const file = await open(out, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        for await (const chunk of file.createReadStream({ autoClose: false })) {
          hash.update(chunk as Buffer);
          bytes += (chunk as Buffer).length;
        }
      } finally {
        await file.close();
      }
      const videoSha256 = hash.digest('hex');
      const folder = join(this.#directory, 'video');
      mkdirSync(folder, { recursive: true, mode: 0o700 });
      await rename(out, join(folder, `${videoSha256}.mp4`));
      await chmod(join(folder, `${videoSha256}.mp4`), 0o600);
      const turned = recording.rotation === 90 || recording.rotation === 270;
      this.#record({
        type: 'recorded.video.made',
        session: recording.recordingId,
        actor: 'person',
        data: {
          recordingId: recording.recordingId,
          videoSha256,
          bytes,
          width: turned ? height : width,
          height: turned ? width : height,
          frameRate:
            recording.durationSeconds === null || recording.durationSeconds <= 0
              ? null
              : Math.round((written / recording.durationSeconds) * 1000) / 1000,
        },
      });
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }

  /** The playback video of the shown recording, for the headset's range reads. */
  video(recordingId: string): { path: string; bytes: number } {
    const made = this.#videos.get(recordingId);
    if (this.#shown?.recordingId !== recordingId || made === undefined)
      return refuse(404, 'recorded_unknown', 'No video of the shown recording.');
    return { path: join(this.#directory, 'video', `${made.videoSha256}.mp4`), bytes: made.bytes };
  }

  /** A projection someone measured for the device that recorded this, kept as that. */
  setProjection(input: unknown): RecordingSummary {
    const parsed = MeasuredProjection.extend({ recordingId: RecordingId }).safeParse(input);
    if (!parsed.success) return invalid('Name a recording and its measured projection.');
    const { recordingId, ...measured } = parsed.data;
    const recording = this.#recordings.get(recordingId);
    if (recording === undefined)
      return refuse(404, 'recorded_unknown', 'No recording has that id.');
    this.#record({
      type: 'recorded.projection.set',
      session: recordingId,
      actor: 'person',
      data: { recordingId, source: 'measured-device-profile', ...measured },
    });
    return this.#summary(recording, false);
  }

  /** Makes display renditions for a recording imported before they existed; returns at once. */
  startDisplay(input: unknown): RecordingSummary {
    const parsed = z.strictObject({ recordingId: RecordingId }).safeParse(input);
    if (!parsed.success) return invalid('Name a recording.');
    const recording = this.#recordings.get(parsed.data.recordingId);
    if (recording === undefined)
      return refuse(404, 'recorded_unknown', 'No recording has that id.');
    if (this.#busy) refuse(409, 'recorded_busy', 'Another import is still running.');
    const extensions = recording.kind === 'video' ? VIDEO : PHOTO;
    const path = extensions
      .map((extension) => join(this.#directory, `${recording.sourceSha256}.${extension}`))
      .find((candidate) => existsSync(candidate));
    if (path === undefined)
      return refuse(404, 'recorded_source_missing', 'The original is not in the store.');
    this.#busy = true;
    this.#displaying.add(recording.recordingId);
    void this.#prepare(recording, path)
      .catch(() => undefined)
      .finally(() => {
        this.#busy = false;
        this.#displaying.delete(recording.recordingId);
      });
    return this.#summary(recording, false);
  }

  /**
   * Starts an outline run over a recording's frames and returns at once; the run is journaled
   * when it ends. The interpreter proposes nouns once, from the recording's middle frame.
   */
  startOutlines(input: unknown): RecordingSummary {
    const parsed = z.strictObject({ recordingId: RecordingId }).safeParse(input);
    if (!parsed.success) return invalid('Name a recording.');
    const outliner = this.#outliner;
    if (outliner === undefined)
      return refuse(503, 'recorded_outlines_unavailable', 'The local scene worker is not running.');
    const recording = this.#recordings.get(parsed.data.recordingId);
    if (recording === undefined)
      return refuse(404, 'recorded_unknown', 'No recording has that id.');
    if (this.#outlining.size > 0) refuse(409, 'recorded_busy', 'An outline run is still going.');
    this.#outlining.add(recording.recordingId);
    void this.#outline(recording, outliner).finally(() =>
      this.#outlining.delete(recording.recordingId),
    );
    return this.#summary(recording, false);
  }

  async #outline(recording: Imported, outliner: Outliner): Promise<void> {
    try {
      const frames = recording.frames.map((frame) => ({
        frameId: frame.frameId,
        jpeg: this.#media.get(frame.frameSha256, 'jpg'),
      }));
      const middle = frames[Math.floor(frames.length / 2)] as { jpeg: Buffer };
      const nouns = await interpreterNouns(outliner.interpreter, middle.jpeg);
      const run = await outlineFrames(
        frames,
        (jpeg, signal, proposed) => outliner.scene.observe(jpeg, signal, proposed),
        nouns,
      );
      this.#record({
        type: 'recorded.outlines.made',
        session: recording.recordingId,
        actor: `model:${outliner.scene.model}`,
        data: {
          recordingId: recording.recordingId,
          provider: outliner.scene.provider,
          model: outliner.scene.model,
          proposedNouns: run.nouns,
          nounModel: { provider: outliner.interpreter.provider, model: outliner.interpreter.model },
          frames: run.outlined,
          failed: run.failed,
          wallMs: Math.round(run.wallMs),
        },
      });
    } catch {
      // A run that cannot finish journals nothing; the recording keeps its earlier outlines.
    }
  }

  /**
   * The shown clip's outlines, each on its own frame and in frame order, all proposed. Served are
   * the outlines whose noun the local interpreter proposed for this recording, and the general
   * list's people (origin "base", label "person"), so the headset keeps its text off them; those
   * people are never drawn or named, and nothing else from the general list is served, so it never
   * names a desert "window". A photo has none (its boop draws its own).
   */
  outlines(): {
    samples: (OutlinedFrame & {
      seconds: number | null;
      provider: string;
      model: string;
      verification: 'proposed';
    })[];
  } {
    const recording =
      this.#shown === null ? undefined : this.#recordings.get(this.#shown.recordingId);
    const run = recording === undefined ? undefined : this.#outlines.get(recording.recordingId);
    if (recording === undefined || run === undefined || recording.kind !== 'video')
      return { samples: [] };
    const byFrame = new Map(run.frames.map((frame) => [frame.frameId, frame]));
    return {
      samples: recording.frames.flatMap((frame) => {
        const outlined = byFrame.get(frame.frameId);
        return outlined === undefined
          ? []
          : [
              {
                ...outlined,
                objects: outlined.objects.filter(
                  (object) =>
                    object.origin === 'proposed' ||
                    (object.origin === 'base' && object.label === 'person'),
                ),
                seconds: frame.seconds,
                provider: run.provider,
                model: run.model,
                verification: 'proposed' as const,
              },
            ];
      }),
    };
  }

  show(input: unknown): SceneView {
    const parsed = ShowRequest.safeParse(input);
    if (!parsed.success) return invalid('Name a recording, and a frame or a moment at most.');
    const { recordingId, frameId, atSeconds } = parsed.data;
    const recording = this.#recordings.get(recordingId);
    if (recording === undefined)
      return refuse(404, 'recorded_unknown', 'No recording has that id.');
    if (frameId !== undefined && atSeconds !== undefined)
      invalid('Name a frame or a moment, not both.');
    let frame = recording.frames[0] as RecordedFrame;
    if (frameId !== undefined)
      frame =
        recording.frames.find((candidate) => candidate.frameId === frameId) ??
        refuse(404, 'recorded_frame_unknown', 'That frame is not in this recording.');
    if (atSeconds !== undefined && recording.kind === 'video')
      frame = recording.frames[
        shownAt(
          recording.frames.map((candidate) => candidate.seconds ?? 0),
          atSeconds,
        )
      ] as RecordedFrame;
    this.#record({
      type: 'recorded.scene.shown',
      session: recordingId,
      actor: 'person',
      data: { recordingId, frameId: frame.frameId },
    });
    return this.scene() as SceneView;
  }

  clear(): void {
    if (this.#shown === null) refuse(409, 'recorded_scene_none', 'No recording is shown.');
    const { recordingId } = this.#shown as { recordingId: string };
    this.#record({
      type: 'recorded.scene.cleared',
      session: recordingId,
      actor: 'person',
      data: { recordingId },
    });
  }

  scene(): SceneView | null {
    if (this.#shown === null) return null;
    const recording = this.#recordings.get(this.#shown.recordingId) as Imported;
    const frame = recording.frames.find(
      (candidate) => candidate.frameId === this.#shown?.frameId,
    ) as RecordedFrame;
    const capturedAt = frameTime(recording, frame);
    // The headset checks the bytes it fetches and their size against these, so they describe the
    // display rendition when there is one.
    const display = this.#display.get(recording.recordingId);
    const shown = display?.get(frame.frameId);
    return {
      recordingId: recording.recordingId,
      frameId: frame.frameId,
      kind: recording.kind,
      width: shown?.width ?? frame.width,
      height: shown?.height ?? frame.height,
      sourceTimeSeconds: frame.seconds,
      durationSeconds: recording.durationSeconds,
      video: (() => {
        const made = this.#videos.get(recording.recordingId);
        return made === undefined
          ? null
          : {
              url: `/v1/recorded/${recording.recordingId}/video`,
              sha256: made.videoSha256,
              width: made.width,
              height: made.height,
              durationSeconds: recording.durationSeconds,
              frameRate: made.frameRate,
            };
      })(),
      projection: (() => {
        const set = this.#projection.get(recording.recordingId);
        return set === undefined
          ? null
          : {
              tanLeft: set.tanLeft,
              tanRight: set.tanRight,
              tanUp: set.tanUp,
              tanDown: set.tanDown,
              source: set.source,
              profile: set.profile,
              centring: set.centring,
            };
      })(),
      capturedAt: { value: capturedAt, trust: capturedAt === null ? 'unknown' : 'unverified' },
      frameSha256: shown?.displaySha256 ?? frame.frameSha256,
      frames: recording.frames.map(({ frameId, seconds, frameSha256 }) => ({
        frameId,
        seconds,
        frameSha256: display?.get(frameId)?.displaySha256 ?? frameSha256,
      })),
    };
  }

  /** The outlines the latest run made on one frame of a recording, or null without one. */
  frameOutlines(
    recordingId: string,
    frameId: string,
  ): { provider: string; model: string; frame: OutlinedFrame } | null {
    const run = this.#outlines.get(recordingId);
    const frame = run?.frames.find((candidate) => candidate.frameId === frameId);
    return run === undefined || frame === undefined
      ? null
      : { provider: run.provider, model: run.model, frame };
  }

  /** A frame of the shown recording as the headset shows it; any other frame is unknown to it. */
  frame(frameId: string): Buffer {
    const recording =
      this.#shown === null ? undefined : this.#recordings.get(this.#shown.recordingId);
    const frame = recording?.frames.find((candidate) => candidate.frameId === frameId);
    if (frame === undefined)
      return refuse(404, 'recorded_frame_unknown', 'That frame is not in the shown recording.');
    const display = this.#display.get((recording as Imported).recordingId)?.get(frameId);
    return this.#media.get(display?.displaySha256 ?? frame.frameSha256, 'jpg');
  }

  /** The exact frame a boop names, from the recording shown now and no other. */
  resolve(reference: { readonly recordingId: string; readonly frameId: string }): ResolvedFrame {
    if (this.#shown?.recordingId !== reference.recordingId)
      return refuse(
        409,
        'recorded_frame_changed',
        'The recording on show changed. Look at the picture again.',
      );
    const recording = this.#recordings.get(reference.recordingId) as Imported;
    const frame = recording.frames.find((candidate) => candidate.frameId === reference.frameId);
    if (frame === undefined)
      return refuse(404, 'recorded_frame_unknown', 'That frame is not in the shown recording.');
    return {
      jpeg: this.#media.get(frame.frameSha256, 'jpg'),
      frameSha256: frame.frameSha256,
      width: frame.width,
      height: frame.height,
      capturedAt: frameTime(recording, frame),
      recorded: {
        recordingId: recording.recordingId,
        frameId: frame.frameId,
        sourceSha256: recording.sourceSha256,
        seconds: frame.seconds,
      },
    };
  }
}

/** The file's own start time plus the frame's place in it, or null when either is unknown. */
function frameTime(recording: Imported, frame: RecordedFrame): string | null {
  const origin = recording.captureOrigin.value;
  if (origin === null) return null;
  return new Date(Date.parse(origin) + Math.round((frame.seconds ?? 0) * 1000)).toISOString();
}

function summary(
  recording: Imported,
  reused: boolean,
): Omit<RecordingSummary, 'outlines' | 'display' | 'video' | 'projection'> {
  return {
    recordingId: recording.recordingId,
    kind: recording.kind,
    frames: recording.frames.length,
    width: recording.width,
    height: recording.height,
    durationSeconds: recording.durationSeconds,
    captureTime: recording.captureOrigin.status,
    reused,
  };
}
