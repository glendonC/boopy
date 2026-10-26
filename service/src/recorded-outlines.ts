/**
 * Outlines over a recording's kept frames, made ahead of playback so they can follow moving
 * subjects. The local scene worker runs on each frame's own still, one at a time, with its general
 * list plus the nouns the local interpreter proposed for this recording. Every result is bound to
 * its frame id: a frame whose run fails has no outlines, and no outline moves to another frame.
 * Outlines stay proposed; a noun from the interpreter placed by the detector is still the
 * interpreter's proposal, never a second opinion.
 */
import { z } from 'zod';
import type { Interpreter } from './interpret/interpreter.ts';
import { SceneObject } from './live-observation.ts';
import { proposedNouns } from './live-scene/local-scene.ts';

/**
 * The worker's answer for one still, keeping where each outline's noun came from. Built on first
 * use: boopy.ts imports this module, and live-observation.ts (which SceneObject comes from)
 * imports boopy.ts, so the schema cannot be read while the modules load.
 */
const outlinesSchema = () =>
  z.object({
    objects: z
      .array(SceneObject.extend({ origin: z.enum(['base', 'proposed']).default('base') }))
      .max(4),
    leftOut: z.number().int().nonnegative().default(0),
    latencyMs: z.number().finite().nonnegative(),
  });
let outlines: ReturnType<typeof outlinesSchema> | undefined;

/** The scene worker as the run calls it: a still, an abort signal, and the proposed nouns. */
export type SceneWorker = (
  jpeg: Buffer,
  signal: AbortSignal | undefined,
  nouns: readonly string[],
) => Promise<unknown>;

export interface OutlinedFrame {
  readonly frameId: string;
  readonly latencyMs: number;
  readonly leftOut: number;
  readonly objects: z.infer<ReturnType<typeof outlinesSchema>>['objects'];
}

export interface OutlineRun {
  readonly nouns: readonly string[];
  readonly outlined: readonly OutlinedFrame[];
  readonly failed: readonly string[];
  readonly wallMs: number;
}

/**
 * The object nouns the local interpreter proposes for one still of the recording, made fit for the
 * detector. A failed or unreadable answer proposes nothing; the general list still runs.
 */
export async function interpreterNouns(interpreter: Interpreter, jpeg: Buffer): Promise<string[]> {
  try {
    const { output } = await interpreter.interpret({
      // The same words for any recording: things that can carry an outline, never people or scenery.
      said: 'Name the separate objects, animals and vehicles in this picture, each as a short singular common noun of one or two words. Leave out people, the ground, the sky and the landscape.',
      language: 'en',
      scope: 'scene',
      gaze: null,
      pointer: null,
      image: jpeg,
      crop: null,
      text: [],
      decisions: [],
    });
    return proposedNouns(
      output.items.filter((item) => item.kind === 'object').map((item) => item.label),
    );
  } catch {
    return [];
  }
}

/** Runs the worker over each frame in order, one at a time, and keeps each result by frame id. */
export async function outlineFrames(
  frames: readonly { readonly frameId: string; readonly jpeg: Buffer }[],
  worker: SceneWorker,
  nouns: readonly string[],
  signal?: AbortSignal,
): Promise<OutlineRun> {
  const started = performance.now();
  const outlined: OutlinedFrame[] = [];
  const failed: string[] = [];
  for (const frame of frames) {
    signal?.throwIfAborted();
    try {
      outlines ??= outlinesSchema();
      const result = outlines.parse(await worker(frame.jpeg, signal, nouns));
      outlined.push({
        frameId: frame.frameId,
        latencyMs: result.latencyMs,
        leftOut: result.leftOut,
        objects: result.objects,
      });
    } catch {
      if (signal?.aborted) throw signal.reason;
      failed.push(frame.frameId);
    }
  }
  return { nouns, outlined, failed, wallMs: performance.now() - started };
}

type Box = { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number };

/** Intersection over union of two normalized boxes. */
export function overlap(a: Box, b: Box): number {
  const width = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const height = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  if (width <= 0 || height <= 0) return 0;
  const shared = width * height;
  const area = (box: Box) => (box.x1 - box.x0) * (box.y1 - box.y0);
  return shared / (area(a) + area(b) - shared);
}

const named = (label: string, noun: string) => {
  const [a, b] = [label, noun].map((text) => text.trim().toLowerCase());
  return (
    a !== '' &&
    b !== '' &&
    ((a as string).includes(b as string) || (b as string).includes(a as string))
  );
};

/**
 * The outline on the same frame that traces an item: its box overlaps the item's box by at least
 * half (intersection over union), an outline whose noun names the item first, then the largest
 * overlap. Null when none qualifies, so the item keeps its box. Only the shape is taken; the item
 * keeps the interpreter's own label.
 */
export function bestOutline<T extends { readonly label: string; readonly box: Box }>(
  item: { readonly label: string; readonly box: Box },
  objects: readonly T[],
  taken: ReadonlySet<T> = new Set(),
): { readonly object: T; readonly overlap: number } | null {
  const candidates = objects
    .filter((object) => !taken.has(object))
    .map((object) => ({ object, overlap: overlap(item.box, object.box) }))
    .filter((candidate) => candidate.overlap >= 0.5);
  candidates.sort(
    (a, b) =>
      Number(named(item.label, b.object.label)) - Number(named(item.label, a.object.label)) ||
      b.overlap - a.overlap,
  );
  return candidates[0] ?? null;
}
