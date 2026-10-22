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
  if (pending.trim() !== '') throw new Error('Truncated segmentation stream.');
}

/** The official parser decodes while parsing: cap dimensions before forwarding any event. */
function validateRasterHeaders(text: string): void {
  let pixels = 0,
    count = 0;
  for (const match of text.matchAll(/data\s*=\s*(\d+),(\d+),/g)) {
    const width = Number(match[2]),
      height = Number(match[1]);
    pixels += width * height;
    count++;
    if (
      !Number.isSafeInteger(width * height) ||
      width < 1 ||
      height < 1 ||
      pixels > MAX_PIXELS ||
      count > MAX_MASKS
    )
      throw new Error('Segmentation raster exceeds limit.');
  }
}

function boxOverlap(a: Box, b: Box): number {
  const overlap =
    Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) *
    Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
  const area = (a.x1 - a.x0) * (a.y1 - a.y0) + (b.x1 - b.x0) * (b.y1 - b.y0) - overlap;
  return area > 0 ? overlap / area : 0;
}

/** Ordered grid-edge contour. Only tiny extra boundaries (up to 1% area) may be omitted. */
export function rasterContour(raster: Uint8Array, width: number, height: number): Point[] {
  if (width < 1 || height < 1 || width * height !== raster.length || width * height > MAX_PIXELS)
    throw new Error('Invalid raster size.');
  const edges = new Map<number, number>();
  const stride = width + 1;
  const add = (x0: number, y0: number, x1: number, y1: number) => {
    const key = y0 * stride + x0;
    if (edges.has(key) || edges.size >= MAX_BOUNDARY) throw new Error('Complex contour.');
    edges.set(key, y1 * stride + x1);
  };
  const at = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < width && y < height && raster[y * width + x] === 1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!at(x, y)) continue;
      if (!at(x, y - 1)) add(x, y, x + 1, y);
      if (!at(x + 1, y)) add(x + 1, y, x + 1, y + 1);
      if (!at(x, y + 1)) add(x + 1, y + 1, x, y + 1);
      if (!at(x - 1, y)) add(x, y + 1, x, y);
    }
  }
  const loops: Point[][] = [];
  while (edges.size > 0) {
    const start = edges.keys().next().value;
    if (start === undefined) throw new Error('Empty mask.');
    const points: Point[] = [];
    let current = start;
    do {
      points.push({ x: current % stride, y: Math.floor(current / stride) });
      const next = edges.get(current);
      if (next === undefined) throw new Error('Open contour.');
      edges.delete(current);
      current = next;
    } while (current !== start);
    loops.push(points);
  }
  loops.sort((a, b) => area(b) - area(a));
  const points = loops[0];
  if (points === undefined || area(points) < 1) throw new Error('Empty mask.');
  if (loops.slice(1).reduce((sum, loop) => sum + area(loop), 0) > area(points) * 0.01)
    throw new Error('Significant multiple boundaries are not supported.');
  const half = Math.floor(points.length / 2);
  let tolerance = 0.75;
  for (let pass = 0; pass < 9; pass++) {
    const simplified = [
      ...simplify(points.slice(0, half + 1), tolerance).slice(0, -1),
      ...simplify([...points.slice(half), points[0] as Point], tolerance).slice(0, -1),
    ];
    if (
      simplified.length >= 3 &&
      simplified.length <= 256 &&
      Math.abs(area(simplified) / area(points) - 1) <= 0.05 &&
      simplePolygon(simplified)
    )
      return simplified;
    tolerance *= 2;
  }
  throw new Error('Contour cannot be represented accurately.');
}

function area(points: readonly Point[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    if (a !== undefined && b !== undefined) sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum / 2);
}

/** Keep a coarse mask boundary from becoming a crossing polygon after simplification. */
function simplePolygon(points: readonly Point[]): boolean {
  const cross = (a: Point, b: Point, c: Point) =>
    (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const on = (a: Point, b: Point, p: Point) =>
    cross(a, b, p) === 0 &&
    p.x >= Math.min(a.x, b.x) &&
    p.x <= Math.max(a.x, b.x) &&
    p.y >= Math.min(a.y, b.y) &&
    p.y <= Math.max(a.y, b.y);
  for (let i = 0; i < points.length; i++) {
    const a = points[i],
      b = points[(i + 1) % points.length];
    if (a === undefined || b === undefined || (a.x === b.x && a.y === b.y)) return false;
    for (let j = i + 2; j < points.length; j++) {
      if (i === 0 && j === points.length - 1) continue;
      const c = points[j],
        d = points[(j + 1) % points.length];
      if (c === undefined || d === undefined) return false;
      if (
        on(a, b, c) ||
        on(a, b, d) ||
        on(c, d, a) ||
        on(c, d, b) ||
        (cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0)
      )
        return false;
    }
  }
  return true;
}

function simplify(points: Point[], tolerance: number): Point[] {
  const first = points[0];
  const last = points.at(-1);
  if (first === undefined || last === undefined) return [];
  const dx = last.x - first.x,
    dy = last.y - first.y;
  if (dx === 0 && dy === 0) throw new Error('Contour simplification has coincident endpoints.');
  let index = 0,
    distance = tolerance;
  for (let i = 1; i < points.length - 1; i++) {
    const point = points[i];
    if (point === undefined) continue;
    const t = Math.max(
      0,
      Math.min(1, ((point.x - first.x) * dx + (point.y - first.y) * dy) / (dx * dx + dy * dy)),
    );
    const d = Math.hypot(point.x - first.x - t * dx, point.y - first.y - t * dy);
    if (d > distance) {
      index = i;
      distance = d;
    }
  }
  return index === 0
    ? [first, last]
    : [
        ...simplify(points.slice(0, index + 1), tolerance).slice(0, -1),
        ...simplify(points.slice(index), tolerance),
      ];
}
