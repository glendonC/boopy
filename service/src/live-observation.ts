import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { z } from 'zod';
import { BoopyError } from './boopy.ts';
import { Box, Frame, Point } from './contracts.ts';
import type { Journal } from './journal.ts';

export const SceneObservationRequest = z
  .object({
    streamId: z.uuid(),
    frameId: z.uuid(),
    sequence: z.number().int().nonnegative(),
    frame: Frame,
  })
  .strict();
export type SceneObservationRequest = z.infer<typeof SceneObservationRequest>;
export const SceneObject = z.object({
  label: z.string().trim().min(1).max(64),
  confidence: z.number().min(0).max(1),
  box: Box,
  contour: z.array(Point).min(3).max(256),
  maskConfidence: z.number().min(0).max(1).optional(),
  maskSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  maskPixels: z.number().int().positive().optional(),
});
export const ScenePerception = z.object({
  objects: z.array(SceneObject).max(4),
  latencyMs: z.number().finite().nonnegative(),
});
export interface ScenePerceiver {
  readonly provider: string;
  readonly model: string;
  observe(jpeg: Buffer, signal?: AbortSignal): Promise<z.infer<typeof ScenePerception>>;
}

/** Live frames remain in memory. Only their hashes, camera provenance and proposed geometry
 * enter this separate journal; they do not create conversation items or verified facts. */
export class LiveObservation {
  #busy = false;
  #completed = 0;
  #lastLatencyMs: number | null = null;
  #lastCompletedAt: string | null = null;
  get diagnostics() {
    return {
      completed: this.#completed,
      lastLatencyMs: this.#lastLatencyMs,
      lastCompletedAt: this.#lastCompletedAt,
    };
  }
  readonly provider: ScenePerceiver;
  readonly journal: Journal;
  constructor(provider: ScenePerceiver, journal: Journal) {
    this.provider = provider;
    this.journal = journal;
  }

  async observe(input: SceneObservationRequest, signal?: AbortSignal) {
    if (this.#busy) throw new BoopyError(409, 'scene_busy', 'Scene update already in progress.');
    this.#busy = true;
    const started = Date.now();
    try {
      signal?.throwIfAborted();
      const bytes = Buffer.from(input.frame.jpeg, 'base64');
      if (bytes.length > 2 * 1024 * 1024)
        throw new BoopyError(413, 'scene_large', 'Scene frame too large.');
      const metadata = await sharp(bytes, { limitInputPixels: 4096 * 4096 }).metadata();
      if (
        metadata.format !== 'jpeg' ||
        metadata.width !== input.frame.width ||
        metadata.height !== input.frame.height
      )
        throw new BoopyError(400, 'scene_frame', 'Scene frame dimensions do not match.');
      const frameSha256 = createHash('sha256').update(bytes).digest('hex');
      const result = ScenePerception.parse(await this.provider.observe(bytes, signal));
      signal?.throwIfAborted();
      const data = {
        streamId: input.streamId,
        frameId: input.frameId,
        sequence: input.sequence,
        capturedAt: input.frame.capturedAt,
        frameSha256,
        camera: input.frame.camera ?? null,
        width: input.frame.width,
        height: input.frame.height,
        provider: this.provider.provider,
        model: this.provider.model,
        verification: 'proposed' as const,
        frameRetained: false as const,
        latencyMs: Date.now() - started,
        objects: result.objects,
      };
      const event = this.journal.append(
        {
          type: 'scene.observed',
          session: input.streamId,
          actor: `model:${this.provider.model}`,
          data,
        },
        randomUUID(),
        new Date().toISOString(),
      );
      this.#completed++;
      this.#lastLatencyMs = data.latencyMs;
      this.#lastCompletedAt = event.at;
      return { ...data, eventId: event.id };
    } finally {
      this.#busy = false;
    }
  }
}
