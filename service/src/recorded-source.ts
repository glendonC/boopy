/**
 * Recorded footage the person brought to this Mac: imported once by the operator, shown to the
 * headset as a still, and booped like a capture. Every frame is an exact frame of the file, never
 * live, and its capture time is the file's own claim (unverified) or unknown. The journal keeps the
 * file's SHA-256 and opaque ids; never its name, its path, a location or its audio.
 */
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { constants, mkdirSync } from 'node:fs';
import { chmod, lstat, mkdtemp, open, readFile, realpath, rm } from 'node:fs/promises';
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
const FFPROBE = '/opt/homebrew/bin/ffprobe';
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

export type RecordedEvent =
  | Envelope<'recorded.source.imported', Imported>
  | Envelope<'recorded.scene.shown', { readonly recordingId: string; readonly frameId: string }>
  | Envelope<'recorded.scene.cleared', { readonly recordingId: string }>
  | Envelope<'recorded.outlines.made', OutlinesMade>;

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

/** The file's own capture-date tags, asked for by name so no other tag value is ever read. */
function videoDates(path: string): Promise<CaptureOrigin> {
  return new Promise((resolve) => {
    const child = spawn(
      FFPROBE,
      [
        ...['-v', 'error', '-protocol_whitelist', 'file', '-format_whitelist', 'mov'],
        ...['-enable_drefs', '0', '-use_absolute_path', '0', '-show_entries'],
        'format_tags=creation_time,com.apple.quicktime.creationdate:stream=index:stream_tags=creation_time,com.apple.quicktime.creationdate',
        ...['-of', 'json', '-i', path],
      ],
      { shell: false, stdio: ['ignore', 'pipe', 'ignore'], env: { LC_ALL: 'C' } },
    );
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 65_536) child.kill('SIGKILL');
      else chunks.push(chunk);
    });
    child.on('error', () => undefined);
    child.on('close', (code) => {
      clearTimeout(timer);
      try {
        if (code !== 0) throw new Error();
        const probe = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          format?: Record<string, unknown>;
          streams?: Record<string, unknown>[];
        };
        resolve(captureOrigin(probe.streams ?? [], probe.format ?? {}));
      } catch {
        // An unreadable answer is no claim at all, never a guessed time.
        resolve(parseCaptureClaims([]));
      }
    });
  });
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
async function cleanStill(bytes: Buffer): Promise<{ jpeg: Buffer; width: number; height: number }> {
  const jpeg = await sharp(bytes, { limitInputPixels: LONG_EDGE * LONG_EDGE })
    .jpeg({ quality: 85 })
    .toBuffer();
  const metadata = await sharp(jpeg).metadata();
  if (
    metadata.format !== 'jpeg' ||
    metadata.width === undefined ||
    metadata.height === undefined ||
    Math.max(metadata.width, metadata.height) > LONG_EDGE ||
    jpeg.length > MAX_STILL_BYTES ||
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
            ...frames.map((frame) => `${frame.time?.value}/${timescale}`),
          ],
          10 * 60_000,
        );
      } else {
        frames = [{ seconds: null, time: null }];
        origin = photoDates(probe);
        answer = await this.#helper(['still-photo', path, work], 60_000);
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
      outlines: {
        running: this.#outlining.has(recording.recordingId),
        frames: this.#outlines.get(recording.recordingId)?.frames.length ?? null,
      },
    };
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
   * The shown clip's outlines, each on its own frame and in frame order, all proposed. Only
   * outlines whose noun the local interpreter proposed for this recording are served, so the
   * general list never names a desert "window"; a photo has none (its boop draws its own).
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
                objects: outlined.objects.filter((object) => object.origin === 'proposed'),
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
    return {
      recordingId: recording.recordingId,
      frameId: frame.frameId,
      kind: recording.kind,
      width: frame.width,
      height: frame.height,
      sourceTimeSeconds: frame.seconds,
      durationSeconds: recording.durationSeconds,
      capturedAt: { value: capturedAt, trust: capturedAt === null ? 'unknown' : 'unverified' },
      frameSha256: frame.frameSha256,
      frames: recording.frames.map(({ frameId, seconds, frameSha256 }) => ({
        frameId,
        seconds,
        frameSha256,
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

  /** A still of the shown recording; any other frame is unknown to the headset. */
  frame(frameId: string): Buffer {
    const recording =
      this.#shown === null ? undefined : this.#recordings.get(this.#shown.recordingId);
    const frame = recording?.frames.find((candidate) => candidate.frameId === frameId);
    if (frame === undefined)
      return refuse(404, 'recorded_frame_unknown', 'That frame is not in the shown recording.');
    return this.#media.get(frame.frameSha256, 'jpg');
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

function summary(recording: Imported, reused: boolean): Omit<RecordingSummary, 'outlines'> {
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
