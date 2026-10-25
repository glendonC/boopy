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

/** The worker's answer for one still, keeping where each outline's noun came from. */
const Outlines = z.object({
  objects: z
    .array(SceneObject.extend({ origin: z.enum(['base', 'proposed']).default('base') }))
    .max(4),
  leftOut: z.number().int().nonnegative().default(0),
  latencyMs: z.number().finite().nonnegative(),
});

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
  readonly objects: z.infer<typeof Outlines>['objects'];
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
      const result = Outlines.parse(await worker(frame.jpeg, signal, nouns));
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
