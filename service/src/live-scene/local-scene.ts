import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const Unit = z.number().finite().min(0).max(1);
const Result = z.object({
  objects: z
    .array(
      z.object({
        label: z.string().trim().min(1).max(100),
        confidence: Unit,
        box: z
          .object({ x0: Unit, y0: Unit, x1: Unit, y1: Unit })
          .refine((b) => b.x0 < b.x1 && b.y0 < b.y1),
        contour: z
          .array(z.object({ x: Unit, y: Unit }))
          .min(3)
          .max(64),
        maskConfidence: Unit,
        maskSha256: z.string().regex(/^[a-f0-9]{64}$/),
        maskPixels: z
          .number()
          .int()
          .min(64)
          .max(640 * 480),
      }),
    )
    .max(4),
  latencyMs: z.number().finite().nonnegative(),
});
export type LocalSceneResult = z.infer<typeof Result>;

type Vertex = { readonly x: number; readonly y: number };
const turn = (a: Vertex, b: Vertex, c: Vertex) =>
  (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
const within = (p: Vertex, q: Vertex, r: Vertex) =>
  r.x >= Math.min(p.x, q.x) - 1e-8 &&
  r.x <= Math.max(p.x, q.x) + 1e-8 &&
  r.y >= Math.min(p.y, q.y) - 1e-8 &&
  r.y <= Math.max(p.y, q.y) + 1e-8;
/** Whether two edges cross or touch, the headset's own test. */
function meets(a: Vertex, b: Vertex, c: Vertex, d: Vertex): boolean {
  const [x, y, u, v] = [turn(a, b, c), turn(a, b, d), turn(c, d, a), turn(c, d, b)];
  return (
    (x * y < 0 && u * v < 0) ||
    (Math.abs(x) < 1e-8 && within(a, b, c)) ||
    (Math.abs(y) < 1e-8 && within(a, b, d)) ||
    (Math.abs(u) < 1e-8 && within(c, d, a)) ||
    (Math.abs(v) < 1e-8 && within(c, d, b))
  );
}

/**
 * Whether the headset can draw this outline, by its own rule (SurfaceGeometry.TryTriangulate in
 * the client package): 3 to 256 points within the frame, no repeated point, no edge that crosses
 * or touches another, some area, and an ear-clipping triangulation.
 */
export function simpleOutline(contour: readonly Vertex[]): boolean {
  const n = contour.length;
  if (n < 3 || n > 256) return false;
  const at = (index: number) => contour[index] as Vertex;
  let area = 0;
  for (let i = 0; i < n; i += 1) {
    const a = at(i);
    const b = at((i + 1) % n);
    if (![a.x, a.y].every((value) => Number.isFinite(value) && value >= 0 && value <= 1))
      return false;
    if ((a.x - b.x) ** 2 + (a.y - b.y) ** 2 < 1e-12) return false;
    area += a.x * b.y - a.y * b.x;
    for (let j = i + 2; j < n; j += 1) {
      if (i === 0 && j === n - 1) continue;
      if (meets(a, b, at(j), at((j + 1) % n))) return false;
    }
  }
  if (Math.abs(area) < 1e-6) return false;
  const winding = Math.sign(area);
  const remaining = Array.from({ length: n }, (_, index) => index);
  while (remaining.length > 3) {
    let found = false;
    for (let i = 0; i < remaining.length; i += 1) {
      const a = remaining[(i + remaining.length - 1) % remaining.length] as number;
      const b = remaining[i] as number;
      const c = remaining[(i + 1) % remaining.length] as number;
      const cross = turn(at(a), at(b), at(c)) * winding;
      if (Math.abs(cross) < 1e-8) {
        remaining.splice(i, 1);
        found = true;
        break;
      }
      if (cross < 0) continue;
      const occupied = remaining.some(
        (point) =>
          point !== a &&
          point !== b &&
          point !== c &&
          turn(at(a), at(b), at(point)) * winding >= -1e-8 &&
          turn(at(b), at(c), at(point)) * winding >= -1e-8 &&
          turn(at(c), at(a), at(point)) * winding >= -1e-8,
      );
      if (occupied) continue;
      remaining.splice(i, 1);
      found = true;
      break;
    }
    if (!found || remaining.length < 3) return false;
  }
  return true;
}
export interface LocalSceneOptions {
  python: string;
  detectorModel: string;
  segmenterModel: string;
  /** A concrete protocol test double may replace the Python entrypoint. */
  workerPath?: string;
  startupTimeoutMs?: number;
  inferenceTimeoutMs?: number;
}

/** Persistent offline inference. One frame in flight; no queue of old wearer views. */
export class LocalScenePerceiver {
  readonly provider = 'local';
  readonly model = 'grounding-dino-tiny+sam2.1-hiera-tiny';
  #options: LocalSceneOptions;
  #child: ChildProcessWithoutNullStreams | null = null;
  #ready: Promise<void> | null = null;
  #readyResolve: (() => void) | null = null;
  #readyReject: ((error: Error) => void) | null = null;
  #startupTimer: ReturnType<typeof setTimeout> | null = null;
  #pending: {
    id: number;
    resolve: (result: LocalSceneResult) => void;
    reject: (error: Error) => void;
  } | null = null;
  #sequence = 0;
  #busy = false;
  #closed = false;
  #device: 'mps' | 'cpu' | null = null;

  constructor(options: LocalSceneOptions) {
    for (const value of [options.python, options.detectorModel, options.segmenterModel])
      if (!value.trim())
        throw new Error('Local scene inference requires explicit runtime and local model paths.');
    for (const value of [options.startupTimeoutMs ?? 30_000, options.inferenceTimeoutMs ?? 5_000])
      if (!Number.isInteger(value) || value < 1 || value > 120_000)
        throw new Error('Invalid local scene deadline.');
    this.#options = options;
  }
  get device(): 'mps' | 'cpu' | null {
    return this.#device;
  }

  ready(): Promise<void> {
    if (this.#closed) return Promise.reject(new Error('Local scene inference is closed.'));
    if (this.#ready) return this.#ready;
    this.#ready = new Promise<void>((resolve, reject) => {
      this.#readyResolve = resolve;
      this.#readyReject = reject;
    });
    const child = spawn(
      this.#options.python,
      [
        this.#options.workerPath ?? fileURLToPath(new URL('./worker.py', import.meta.url)),
        '--detector-model',
        this.#options.detectorModel,
        '--segmenter-model',
        this.#options.segmenterModel,
      ],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' },
      },
    );
    this.#child = child;
    // Discard library diagnostics; never add raw media to application logs.
    child.stderr.resume();
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (this.#child !== child) return;
      buffer += chunk;
      if (buffer.length > 256_000) {
        this.#stop(new Error('Local scene worker returned an invalid response.'));
        return;
      }
      let boundary = buffer.indexOf('\n');
      while (boundary >= 0 && this.#child === child) {
        const line = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 1);
        this.#receive(line);
        boundary = buffer.indexOf('\n');
      }
    });
    child.on('error', () => {
      if (this.#child === child) this.#stop(new Error('Local scene worker could not start.'));
    });
    child.on('exit', () => {
      if (this.#child === child) this.#stop(new Error('Local scene worker stopped.'));
    });
    child.stdin.on('error', () => {
      if (this.#child === child) this.#stop(new Error('Local scene worker connection closed.'));
    });
    this.#startupTimer = setTimeout(
      () => this.#stop(new Error('Local scene model startup timed out.')),
      this.#options.startupTimeoutMs ?? 30_000,
    );
    return this.#ready;
  }

  async observe(jpeg: Buffer, signal?: AbortSignal): Promise<LocalSceneResult> {
    signal?.throwIfAborted();
    if (this.#busy) throw new Error('Local scene inference is already processing a frame.');
    if (jpeg.length < 4 || jpeg.length > 4 * 1024 * 1024 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8)
      throw new Error('Local scene inference requires a bounded JPEG.');
    this.#busy = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const aborted = () =>
      this.#stop(new DOMException('Local scene observation cancelled.', 'AbortError'));
    signal?.addEventListener('abort', aborted, { once: true });
    try {
      await this.ready();
      signal?.throwIfAborted();
      const id = ++this.#sequence;
      const result = new Promise<LocalSceneResult>((resolve, reject) => {
        this.#pending = { id, resolve, reject };
      });
      timer = setTimeout(
        () => this.#stop(new Error('Local scene inference timed out.')),
        this.#options.inferenceTimeoutMs ?? 5_000,
      );
      this.#child?.stdin.write(`${JSON.stringify({ id, jpeg: jpeg.toString('base64') })}\n`);
      return await result;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', aborted);
      this.#busy = false;
    }
  }
  async close(): Promise<void> {
    this.#closed = true;
    this.#stop(new Error('Local scene inference closed.'));
  }

  #receive(line: string): void {
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.#stop(new Error('Local scene worker returned an invalid response.'));
      return;
    }
    if (
      value?.type === 'ready' &&
      (value.device === 'mps' || value.device === 'cpu') &&
      this.#readyResolve
    ) {
      if (this.#startupTimer) clearTimeout(this.#startupTimer);
      this.#startupTimer = null;
      this.#device = value.device;
      this.#readyResolve();
      this.#readyResolve = null;
      this.#readyReject = null;
      return;
    }
    const pending = this.#pending;
    if (value?.type === 'result' && pending && value.id === pending.id) {
      const result = Result.safeParse(value);
      if (result.success) {
        this.#pending = null;
        // The headset refuses a whole frame when one outline is not simple, so such an object is
        // left out here, never reshaped, and the frame keeps its other objects.
        const objects = result.data.objects.filter((object) => simpleOutline(object.contour));
        pending.resolve({ ...result.data, objects });
        return;
      }
    }
    this.#stop(
      new Error(
        value?.type === 'startup-error'
          ? 'Local scene models are unavailable.'
          : 'Local scene inference returned no valid masks.',
      ),
    );
  }
  #stop(error: Error): void {
    const child = this.#child;
    this.#child = null;
    if (this.#startupTimer) clearTimeout(this.#startupTimer);
    this.#startupTimer = null;
    this.#readyReject?.(error);
    this.#readyResolve = null;
    this.#readyReject = null;
    this.#pending?.reject(error);
    this.#pending = null;
    this.#ready = null;
    this.#device = null;
    child?.kill('SIGKILL');
  }
}
