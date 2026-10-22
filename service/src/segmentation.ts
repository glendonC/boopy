import {
  decodeMaskToRaster,
  parseImageStream,
  recordsOfKind,
  type SegmentationMaskRecord,
} from '@meta-sam/parser';
import sharp from 'sharp';
import type { Box, Point, SpatialEvidence } from './contracts.ts';

export interface SegmentInput {
  readonly image: Buffer;
  readonly width: number;
  readonly height: number;
  readonly concept: string;
  readonly box: Box;
  readonly focus: Point | null;
}

export interface SegmentResult {
  readonly outcome: SpatialEvidence['outcome'];
  readonly latencyMs: number;
  readonly confidence: number | null;
  readonly contour?: readonly Point[];
  /** Exact selected mask record retained privately with its hash, never sent to the connector. */
  readonly mask?: Buffer;
  /** Exact concept sent when repeated-item requests share one hosted response. */
  readonly concept?: string;
}

/** A concrete hosted implementation and test doubles share this small boundary. */
export interface Segmenter {
  readonly provider: 'meta';
  readonly model: 'sam-3.1';
  segment(input: SegmentInput, signal?: AbortSignal): Promise<SegmentResult>;
  segmentMany?(
    inputs: readonly SegmentInput[],
    signal?: AbortSignal,
    completed?: (index: number, result: SegmentResult) => void,
  ): Promise<readonly SegmentResult[]>;
}

export const MAX_SEGMENT_ITEMS = 4;
export const SEGMENT_CONCURRENCY = 2;
export const SEGMENT_BUDGET_MS = 12_000;

const MAX_PIXELS = 4_000_000;
const MAX_STREAM_BYTES = 8_000_000;
const MAX_MASKS = 32;
const MAX_BOUNDARY = 20_000;

/** Opt-in only: the original unmarked frame leaves the Mac for this request. */
export class SamSegmenter implements Segmenter {
  readonly provider = 'meta';
  readonly model = 'sam-3.1';
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: { apiKey: string; fetch?: typeof fetch; timeoutMs?: number }) {
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 12_000;
  }

  async segment(input: SegmentInput, signal?: AbortSignal): Promise<SegmentResult> {
    const results = await this.segmentMany([input], signal);
    return results[0] ?? { outcome: 'failed', latencyMs: 0, confidence: null };
  }

  async segmentMany(
    inputs: readonly SegmentInput[],
    signal?: AbortSignal,
    completed?: (index: number, result: SegmentResult) => void,
  ): Promise<readonly SegmentResult[]> {
    if (inputs.length === 0) return [];
    const first = inputs[0];
    if (
      first === undefined ||
      inputs.length > MAX_SEGMENT_ITEMS ||
      inputs.some(
        (input) =>
          input.width !== first.width ||
          input.height !== first.height ||
          !input.image.equals(first.image),
      )
    )
      return inputs.map(() => ({ outcome: 'failed', latencyMs: 0, confidence: null }));
    const groups = new Map<string, { input: SegmentInput; index: number }[]>();
    inputs.forEach((input, index) => {
      const key = input.concept.trim().toLocaleLowerCase('en-US');
      const group = groups.get(key) ?? [];
      group.push({ input, index });
      groups.set(key, group);
    });
    const results: SegmentResult[] = inputs.map(() => ({
      outcome: 'failed',
      latencyMs: 0,
      confidence: null,
    }));
    await parallel([...groups.values()], async (group) => {
      if (signal?.aborted) return;
      const answers = await this.#segmentGroup(
        group.map((entry) => entry.input),
        signal,
      );
      group.forEach((entry, index) => {
        results[entry.index] = answers[index] ?? (results[entry.index] as SegmentResult);
        completed?.(entry.index, results[entry.index] as SegmentResult);
      });
    });
    return results;
  }

  async #segmentGroup(
    inputs: readonly SegmentInput[],
    signal?: AbortSignal,
  ): Promise<SegmentResult[]> {
    const input = inputs[0];
    if (input === undefined) return [];
    const started = performance.now();
    const result = (outcome: SegmentResult['outcome']): SegmentResult => ({
      outcome,
      latencyMs: Math.round(performance.now() - started),
      confidence: null,
      concept: input.concept,
    });
    const all = (outcome: SegmentResult['outcome']) => inputs.map(() => result(outcome));
    try {
      if (
        input.concept.trim() === '' ||
        input.concept.length > 120 ||
        !Number.isSafeInteger(input.width * input.height) ||
        input.width * input.height > MAX_PIXELS
      )
        return all('failed');
      const metadata = await sharp(input.image, { limitInputPixels: MAX_PIXELS }).metadata();
      if (metadata.width !== input.width || metadata.height !== input.height) return all('failed');
      if (signal?.aborted) return all('failed');
      const response = await this.#fetch('https://api.meta.ai/v1/responses', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.#apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body: JSON.stringify({
          model: this.model,
          input: [
            {
              type: 'message',
              role: 'user',
              content: [
                { type: 'input_text', text: input.concept },
                {
                  type: 'input_image',
                  image_url: `data:image/jpeg;base64,${input.image.toString('base64')}`,
                },
              ],
            },
          ],
          stream: true,
          metadata: { mask_encoding: 'one_bit' },
        }),
        signal:
          signal === undefined
            ? AbortSignal.timeout(this.#timeoutMs)
            : AbortSignal.any([signal, AbortSignal.timeout(this.#timeoutMs)]),
      });
      if (!response.ok || response.body === null) {
        await response.body?.cancel();
        return all('failed');
      }
      const parsed = await parseImageStream(streamEvents(response.body)).finalResult;
      if (
        parsed.outcome.status !== 'completed' ||
        parsed.diagnostics.length > 0 ||
        recordsOfKind(parsed.records, 'text').length > 0
      )
        return all('failed');
      // The parser exposes cropped bounds, not source dimensions: verify the wire dimensions
      // before normalizing so a mismatched provider frame cannot masquerade as precise geometry.
      for (const token of parsed.rawOutput.matchAll(/<\|box;([^|]+)\|>/g)) {
        const fields = new Map(
          token[1]?.split(';').map((field) => field.split('=')) as [string, string][],
        );
        if (Number(fields.get('w')) !== input.width || Number(fields.get('h')) !== input.height)
          return all('failed');
      }
      const records = recordsOfKind(parsed.records, 'mask');
      if (records.length === 0) return all('no-match');
      if (records.length > MAX_MASKS) return all('failed');
      const candidates: { record: SegmentationMaskRecord; raster: Uint8Array }[] = [];
      for (const record of records) {
        const { bounds, mask } = record;
        if (
          bounds.left < 0 ||
          bounds.top < 0 ||
          bounds.right > input.width ||
          bounds.bottom > input.height ||
          mask.width * mask.height > MAX_PIXELS ||
          mask.width > input.width ||
          mask.height > input.height ||
          bounds.right - bounds.left !== mask.width ||
          bounds.bottom - bounds.top !== mask.height
        )
          return all('failed');
        const raster = decodeMaskToRaster(mask);
        candidates.push({ record, raster });
      }
      const selectedIds: (string | null)[] = [];
      const answers = inputs.map((target) => {
        const matches = candidates.filter(({ record, raster }) => {
          const { bounds, mask } = record;
          const box: Box = {
            x0: bounds.left / input.width,
            y0: bounds.top / input.height,
            x1: bounds.right / input.width,
            y1: bounds.bottom / input.height,
          };
          if (boxOverlap(box, target.box) < 0.1) return false;
          if (target.focus === null) return boxOverlap(box, target.box) >= 0.5;
          const x = Math.floor(target.focus.x * input.width - bounds.left);
          const y = Math.floor(target.focus.y * input.height - bounds.top);
          return (
            x >= 0 &&
            y >= 0 &&
            x < mask.width &&
            y < mask.height &&
            raster[y * mask.width + x] === 1
          );
        });
        const selected = matches.length === 1 ? matches[0] : undefined;
        selectedIds.push(selected?.record.objectId ?? null);
        if (selected === undefined) return result(matches.length === 0 ? 'no-match' : 'ambiguous');
        try {
          const points = rasterContour(
            selected.raster,
            selected.record.mask.width,
            selected.record.mask.height,
          );
          return {
            ...result('contour'),
            confidence: selected.record.confidence ?? null,
            contour: points.map((point) => ({
              x: (selected.record.bounds.left + point.x) / input.width,
              y: (selected.record.bounds.top + point.y) / input.height,
            })),
            mask: Buffer.from(JSON.stringify(selected.record)),
          };
        } catch {
          return result('failed');
        }
      });
      // One response-local instance must not be assigned to two distinct semantic objects.
      return answers.map((answer, index) =>
        selectedIds[index] !== null &&
        selectedIds.filter((id) => id === selectedIds[index]).length > 1
          ? result('ambiguous')
          : answer,
      );
    } catch {
      // SDK/transport failures may contain headers, content or credentials. Never log them.
      return all('failed');
    }
  }
}

/** Entire refinement phase is bounded, including a test double that ignores AbortSignal. */
export async function segmentItems(
  segmenter: Segmenter,
  inputs: readonly SegmentInput[],
  budgetMs = SEGMENT_BUDGET_MS,
): Promise<readonly SegmentResult[]> {
  const selected = inputs.slice(0, MAX_SEGMENT_ITEMS);
  if (selected.length === 0) return [];
  if (!Number.isFinite(budgetMs) || budgetMs <= 0)
    throw new RangeError('Invalid segmentation budget.');
  const started = performance.now();
  const controller = new AbortController();
  const failed = () =>
    selected.map(() => ({
      outcome: 'failed' as const,
      latencyMs: Math.round(performance.now() - started),
      confidence: null,
    }));
  const results: SegmentResult[] = failed();
  const completed = selected.map(() => false);
  const finish = (index: number, result: SegmentResult) => {
    results[index] = result;
    completed[index] = true;
  };
  const snapshot = () =>
    results.map((result, index) =>
      completed[index] ? result : (failed()[index] as SegmentResult),
    );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<readonly SegmentResult[]>((resolve) => {
    timer = setTimeout(
      () => {
        controller.abort();
        resolve(snapshot());
      },
      Math.min(budgetMs, SEGMENT_BUDGET_MS),
    );
  });
  const work = (async () => {
    if (segmenter.segmentMany !== undefined)
      return await segmenter.segmentMany(selected, controller.signal, finish);
    await parallel(
      selected.map((input, index) => ({ input, index })),
      async ({ input, index }) => {
        if (controller.signal.aborted) return;
        const result = await segmenter
          .segment(input, controller.signal)
          .catch(() => failed()[index] as SegmentResult);
        finish(index, result);
      },
    );
    return results;
  })().catch(snapshot);
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function parallel<T>(values: readonly T[], work: (value: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(SEGMENT_CONCURRENCY, values.length) }, async () => {
      while (cursor < values.length) {
        const value = values[cursor++];
        if (value !== undefined) await work(value);
      }
    }),
  );
}

async function* streamEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<{ type: string }> {
  const decoder = new TextDecoder();
  let bytes = 0;
  let pending = '';
  let outputText = '';
  let outputEvents = 0;
  for await (const chunk of body) {
    bytes += chunk.byteLength;
    if (bytes > MAX_STREAM_BYTES) throw new Error('Segmentation response exceeds limit.');
    pending += decoder.decode(chunk, { stream: true });
    let split = pending.indexOf('\n');
    while (split >= 0) {
      const line = pending.slice(0, split).replace(/\r$/, '');
      pending = pending.slice(split + 1);
      split = pending.indexOf('\n');
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6);
      if (data === '[DONE]') return;
      const event: unknown = JSON.parse(data);
      if (
        typeof event !== 'object' ||
        event === null ||
        !('type' in event) ||
        typeof event.type !== 'string'
      )
        throw new Error('Invalid segmentation event.');
      if (event.type === 'response.output_text.delta') {
        outputEvents++;
        if (outputEvents > 128) throw new Error('Too many segmentation text fragments.');
        if (!('delta' in event) || typeof event.delta !== 'string')
          throw new Error('Invalid segmentation output.');
        outputText += event.delta;
        validateRasterHeaders(outputText);
      }
      if (event.type === 'response.output_text.done') {
        if (!('text' in event) || typeof event.text !== 'string')
          throw new Error('Invalid segmentation output.');
        validateRasterHeaders(event.text);
      }
      if (
        event.type === 'response.content_part.done' &&
        'part' in event &&
        typeof event.part === 'object' &&
        event.part !== null &&
        'type' in event.part &&
        event.part.type === 'output_text'
      ) {
        if (!('text' in event.part) || typeof event.part.text !== 'string')
          throw new Error('Invalid segmentation output.');
        validateRasterHeaders(event.part.text);
      }
      yield event as { type: string };
    }
  }
}
