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
        pending.resolve(result.data);
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
