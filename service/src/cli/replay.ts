/**
 * pnpm replay: the operator's steps on the Mac for recorded footage.
 *
 *   inspect --input FILE                      the bounded 10-19 preflight, codes only
 *   import  --input FILE --data-dir DIR [--stills N | --at S,S | --every S] [--start S] [--duration S]
 *   list    --data-dir DIR
 *   show    --data-dir DIR --recording ID [--frame ID | --at S]
 *   clear   --data-dir DIR
 *   outline --data-dir DIR --recording ID     outlines for every kept frame, journaled when done
 *   display --data-dir DIR --recording ID     the headset's sharper stills, the playback video and a
 *                                             lens projection, for a recording imported before
 *   projection --data-dir DIR --recording ID --tan-left T --tan-right T --tan-up T --tan-down T
 *              --profile NAME --centring measured|inferred [--reference NAME:L,R,U,D]
 *                                             a projection measured for the device that recorded it
 *
 * Import copies the chosen file into DIR/recorded under its SHA-256 (private, never moving or
 * changing the original), then asks the running service through the authenticated local connector.
 * Nothing printed carries a file name, a path, a capture time or any other metadata value.
 */
import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import {
  inspectRecordedMedia,
  isSelectedLocalPath,
  RecordedMediaError,
} from '../recorded-media.ts';
import { call as connectorCall } from './activity.ts';

type Summary = {
  videoFrames: number;
  audioTracks: number;
  captureOrigin: { status: 'unknown' | 'conflict' | 'unverified' };
};
type Connection = { dataDir: string; port?: number };
type Call = (
  connection: Connection,
  path: string,
  body?: unknown,
  method?: string,
) => Promise<unknown>;

const EXTENSIONS = ['mov', 'mp4', 'm4v', 'heic', 'heif', 'jpg', 'jpeg', 'png'];
const MAX_SOURCE_BYTES = 4 * 1024 ** 3;
const NUMBER = /^\d+(?:\.\d+)?$/;
const Recording = z.object({
  recordingId: z.string().regex(/^rec_[a-f0-9]{32}$/),
  kind: z.enum(['video', 'photo']),
  frames: z.number().int(),
  captureTime: z.enum(['unknown', 'conflict', 'unverified']),
  reused: z.boolean(),
  outlines: z.object({ running: z.boolean(), frames: z.number().int().nullable() }).optional(),
  display: z.object({ running: z.boolean(), frames: z.number().int().nullable() }).optional(),
});
const outlined = (entry: z.infer<typeof Recording>) =>
  (entry.outlines === undefined
    ? ''
    : `; outlines=${entry.outlines.running ? 'running' : (entry.outlines.frames ?? 'none')}`) +
  (entry.display === undefined
    ? ''
    : `; display=${entry.display.running ? 'running' : (entry.display.frames ?? 'none')}`);
const Scene = z.object({
  scene: z
    .object({
      recordingId: z.string().regex(/^rec_[a-f0-9]{32}$/),
      frameId: z.string().regex(/^rfr_[a-f0-9]{32}$/),
      frames: z.array(z.unknown()),
    })
    .nullable(),
});

/** A refusal whose words are fixed here and safe to print. */
class Refusal extends Error {}

export async function runReplayCli(
  args: string[],
  dependencies: {
    inspect?: (path: string) => Promise<Summary>;
    call?: Call;
    print?: (line: string) => void;
  } = {},
): Promise<number> {
  const print = dependencies.print ?? console.log;
  const [command] = args;
  if (command === 'inspect') return inspect(args, dependencies.inspect, print);
  const operation = command === undefined ? null : operator(command, args.slice(1));
  if (operation === null) {
    print('recorded-media: invalid_arguments');
    return 1;
  }
  try {
    for (const line of await operation(dependencies.call ?? connectorCall)) print(line);
    return 0;
  } catch (error) {
    print(`recorded: ${error instanceof Error ? error.message : 'failed'}`);
    return 1;
  }
}

async function inspect(
  args: string[],
  run: ((path: string) => Promise<Summary>) | undefined,
  print: (line: string) => void,
): Promise<number> {
  const [, flag, input] = args;
  if (args.length !== 3 || flag !== '--input' || !input || !isSelectedLocalPath(input)) {
    print('recorded-media: invalid_arguments');
    return 1;
  }
  try {
    const result = await (run ?? inspectRecordedMedia)(input);
    print(
      `recorded-media: inspected; video-frames=${result.videoFrames}; audio-tracks=${result.audioTracks}; capture-time=${result.captureOrigin.status}`,
    );
    return 0;
  } catch (error) {
    print(`recorded-media: ${error instanceof RecordedMediaError ? error.code : 'inspect_failed'}`);
    return 1;
  }
}

/** The operator command these arguments name, or null when they do not parse exactly. */
function operator(command: string, rest: string[]): ((call: Call) => Promise<string[]>) | null {
  let values: Record<string, string | undefined>;
  try {
    values = parseArgs({
      args: rest,
      strict: true,
      allowPositionals: false,
      options: Object.fromEntries(
        [
          'input',
          'data-dir',
          'port',
          'stills',
          'at',
          'every',
          'start',
          'duration',
          'recording',
          'frame',
          'tan-left',
          'tan-right',
          'tan-up',
          'tan-down',
          'profile',
          'centring',
          'reference',
        ].map((name) => [name, { type: 'string' as const }]),
      ),
    }).values as Record<string, string | undefined>;
  } catch {
    return null;
  }
  const dataDir = values['data-dir'];
  if (dataDir === undefined || !isSelectedLocalPath(dataDir)) return null;
  if (values.port !== undefined && !/^\d{1,5}$/.test(values.port)) return null;
  const connection: Connection = {
    dataDir,
    ...(values.port === undefined ? {} : { port: Number(values.port) }),
  };
  const allowed = (names: string[]) =>
    Object.entries(values).every(([name, value]) => value === undefined || names.includes(name));
  if (command === 'import') {
    const input = values.input;
    const extension = input === undefined ? '' : extname(input).slice(1).toLowerCase();
    const sampling = samplingOf(values);
    if (
      !allowed(['input', 'data-dir', 'port', 'stills', 'at', 'every', 'start', 'duration']) ||
      input === undefined ||
      !isSelectedLocalPath(input) ||
      !EXTENSIONS.includes(extension) ||
      sampling === null
    )
      return null;
    return async (call) => {
      const sha256 = await storeCopy(input, dataDir);
      const answer = Recording.parse(
        await call(connection, '/v1/local-recorded/imports', {
          sha256,
          extension,
          ...(sampling === undefined ? {} : { sampling }),
        }),
      );
      return [
        `recorded: imported; recording=${answer.recordingId}; kind=${answer.kind}; frames=${answer.frames}; capture-time=${answer.captureTime}${answer.reused ? '; reused' : ''}`,
      ];
    };
  }
  if (command === 'list') {
    if (!allowed(['data-dir', 'port'])) return null;
    return async (call) =>
      z
        .object({ recordings: z.array(Recording) })
        .parse(await call(connection, '/v1/local-recorded/recordings', undefined, 'GET'))
        .recordings.map(
          (entry) =>
            `recorded: ${entry.recordingId}; kind=${entry.kind}; frames=${entry.frames}; capture-time=${entry.captureTime}${outlined(entry)}`,
        );
  }
  if (command === 'show') {
    const { recording, frame, at } = values;
    if (
      !allowed(['data-dir', 'port', 'recording', 'frame', 'at']) ||
      recording === undefined ||
      !/^rec_[a-f0-9]{32}$/.test(recording) ||
      (frame !== undefined && !/^rfr_[a-f0-9]{32}$/.test(frame)) ||
      (at !== undefined && !NUMBER.test(at)) ||
      (frame !== undefined && at !== undefined)
    )
      return null;
    return async (call) => {
      const { scene } = Scene.parse(
        await call(connection, '/v1/local-recorded/scene', {
          recordingId: recording,
          ...(frame === undefined ? {} : { frameId: frame }),
          ...(at === undefined ? {} : { atSeconds: Number(at) }),
        }),
      );
      if (scene === null) throw new Refusal('No recording is shown.');
      return [
        `recorded: showing; recording=${scene.recordingId}; frame=${scene.frameId}; frames=${scene.frames.length}`,
      ];
    };
  }
  if (command === 'projection') {
    const { recording, profile, centring, reference } = values;
    const tangents = ['tan-left', 'tan-right', 'tan-up', 'tan-down'].map((name) => values[name]);
    const referenced =
      reference === undefined ? null : /^([a-z0-9][a-z0-9-]{0,63}):(.+)$/.exec(reference);
    const referenceTangents = referenced?.[2]?.split(',') ?? [];
    if (
      !allowed([
        'data-dir',
        'port',
        'recording',
        'tan-left',
        'tan-right',
        'tan-up',
        'tan-down',
        'profile',
        'centring',
        'reference',
      ]) ||
      recording === undefined ||
      !/^rec_[a-f0-9]{32}$/.test(recording) ||
      profile === undefined ||
      (centring !== 'measured' && centring !== 'inferred') ||
      !tangents.every((value) => value !== undefined && NUMBER.test(value)) ||
      (reference !== undefined &&
        (referenced === null ||
          referenceTangents.length !== 4 ||
          !referenceTangents.every((value) => NUMBER.test(value))))
    )
      return null;
    const [tanLeft, tanRight, tanUp, tanDown] = tangents.map(Number);
    return async (call) => {
      const answer = Recording.parse(
        await call(connection, '/v1/local-recorded/projection', {
          recordingId: recording,
          tanLeft,
          tanRight,
          tanUp,
          tanDown,
          profile,
          centring,
          ...(referenced === null
            ? {}
            : {
                reference: {
                  profile: referenced[1],
                  tanLeft: Number(referenceTangents[0]),
                  tanRight: Number(referenceTangents[1]),
                  tanUp: Number(referenceTangents[2]),
                  tanDown: Number(referenceTangents[3]),
                },
              }),
        }),
      );
      return [
        `recorded: projection set; recording=${answer.recordingId}; source=measured-device-profile`,
      ];
    };
  }
  if (command === 'display') {
    const { recording } = values;
    if (
      !allowed(['data-dir', 'port', 'recording']) ||
      recording === undefined ||
      !/^rec_[a-f0-9]{32}$/.test(recording)
    )
      return null;
    return async (call) => {
      const answer = Recording.parse(
        await call(connection, '/v1/local-recorded/display', { recordingId: recording }),
      );
      return [
        `recorded: making display stills; recording=${answer.recordingId}; frames=${answer.frames}; see pnpm replay list`,
      ];
    };
  }
  if (command === 'outline') {
    const { recording } = values;
    if (
      !allowed(['data-dir', 'port', 'recording']) ||
      recording === undefined ||
      !/^rec_[a-f0-9]{32}$/.test(recording)
    )
      return null;
    return async (call) => {
      const answer = Recording.parse(
        await call(connection, '/v1/local-recorded/outlines', { recordingId: recording }),
      );
      return [
        `recorded: outlining; recording=${answer.recordingId}; frames=${answer.frames}; see pnpm replay list`,
      ];
    };
  }
  if (command === 'clear') {
    if (!allowed(['data-dir', 'port'])) return null;
    return async (call) => {
      await call(connection, '/v1/local-recorded/scene/clear', {});
      return ['recorded: cleared'];
    };
  }
  return null;
}

/** At most one of --stills, --at and --every; a window only with --stills or --every. */
function samplingOf(values: Record<string, string | undefined>): object | undefined | null {
  const { stills, at, every, start, duration } = values;
  const chosen = [stills, at, every].filter((value) => value !== undefined).length;
  if (
    chosen > 1 ||
    ((start !== undefined || duration !== undefined) && (chosen === 0 || at !== undefined))
  )
    return null;
  if ([start, duration, every].some((value) => value !== undefined && !NUMBER.test(value)))
    return null;
  const window = {
    ...(start === undefined ? {} : { startSeconds: Number(start) }),
    ...(duration === undefined ? {} : { durationSeconds: Number(duration) }),
  };
  if (stills !== undefined)
    return /^\d{1,2}$/.test(stills) ? { mode: 'stills', count: Number(stills), ...window } : null;
  if (every !== undefined) return { mode: 'every', seconds: Number(every), ...window };
  if (at !== undefined) {
    const moments = at.split(',');
    return moments.length <= 60 && moments.every((moment) => NUMBER.test(moment))
      ? { mode: 'at', seconds: moments.map(Number) }
      : null;
  }
  return undefined;
}

/**
 * Copies the chosen file into DIR/recorded as SHA256.EXT, mode 0600, through a private temporary
 * file in the same folder. The original is opened read-only and never moved or changed.
 */
async function storeCopy(input: string, dataDir: string): Promise<string> {
  const refusal = () => new Refusal('Choose a regular photo or video file, not a link or folder.');
  let source: Awaited<ReturnType<typeof open>>;
  try {
    source = await open(
      resolve(input),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch {
    throw refusal();
  }
  const store = join(resolve(dataDir), 'recorded');
  const temporary = join(store, `.incoming-${randomBytes(8).toString('hex')}`);
  let written = false;
  try {
    const info = await source.stat();
    if (!info.isFile()) throw refusal();
    if (info.size <= 0 || info.size > MAX_SOURCE_BYTES)
      throw new Refusal('Recordings are at most 4 GiB.');
    await mkdir(store, { recursive: true, mode: 0o700 });
    const folder = await lstat(store);
    if (!folder.isDirectory()) throw new Refusal('The recording store must be a plain folder.');
    await chmod(store, 0o700);
    const target = await open(temporary, 'wx', 0o600);
    written = true;
    const hash = createHash('sha256');
    try {
      for await (const chunk of source.createReadStream({ autoClose: false })) {
        hash.update(chunk as Buffer);
        await target.write(chunk as Buffer);
      }
    } finally {
      await target.close();
    }
    const sha256 = hash.digest('hex');
    const extension = extname(input).slice(1).toLowerCase();
    const final = join(store, `${sha256}.${extension}`);
    let present = false;
    try {
      present = (await lstat(final)).isFile();
      if (!present) throw new Refusal('The recording store holds something else under that name.');
    } catch (error) {
      if (error instanceof Refusal) throw error;
    }
    if (present) await unlink(temporary);
    else await rename(temporary, final);
    written = false;
    return sha256;
  } finally {
    await source.close();
    if (written) await unlink(temporary).catch(() => undefined);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runReplayCli(process.argv.slice(2));
}
