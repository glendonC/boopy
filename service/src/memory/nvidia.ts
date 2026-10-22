/** Explicit local-only NVIDIA ranking. Caller supplies already-selected current text, never journals. */
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const MODEL = 'nvidia/nemotron-3-embed-1b';
const REVISION = 'c0c9fea93ea424587517f2c59e20db9f1d6bf615';
const Vector = z.array(z.number().finite()).length(2048);
const Reply = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('ready'),
      model: z.literal(MODEL),
      revision: z.literal(REVISION),
      dimension: z.literal(2048),
    })
    .strict(),
  z
    .object({
      type: z.literal('result'),
      id: z.string(),
      query: Vector,
      passages: z.array(z.object({ sourceId: z.string(), embedding: Vector }).strict()).max(20),
    })
    .strict(),
  z
    .object({
      type: z.literal('error'),
      id: z.string(),
      code: z.enum(['too_long', 'invalid_request', 'inference_failed']),
    })
    .strict(),
]);
const Input = z
  .object({
    query: z.string().trim().min(1).max(500),
    candidates: z
      .array(
        z
          .object({ sourceId: z.string().min(1).max(512), text: z.string().min(1).max(8000) })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict();
export type NvidiaCandidate = { sourceId: string; text: string };
export class NvidiaEmbeddingWorker {
  private child: ChildProcessWithoutNullStreams | null = null;
  private ready = false;
  private buffer = '';
  private pending: {
    id: string;
    send: () => void;
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  } | null = null;
  private readonly options: {
    pythonPath: string;
    modelDirectory: string;
    device: 'cpu' | 'mps';
    timeoutMs: number;
    startupTimeoutMs: number;
    scriptPath: string;
  };
  constructor(options: {
    pythonPath: string;
    modelDirectory: string;
    device: 'cpu' | 'mps';
    timeoutMs?: number;
    startupTimeoutMs?: number /** Explicit protocol test double only. */;
    scriptPath?: string;
  }) {
    this.options = {
      ...options,
      timeoutMs: options.timeoutMs ?? 10000,
      startupTimeoutMs: options.startupTimeoutMs ?? 60000,
      scriptPath:
        options.scriptPath ??
        fileURLToPath(new URL('../../probes/nvidia/worker.py', import.meta.url)),
    };
    if (
      ![this.options.pythonPath, this.options.modelDirectory, this.options.scriptPath].every(
        isAbsolute,
      ) ||
      !['cpu', 'mps'].includes(options.device) ||
      ![this.options.timeoutMs, this.options.startupTimeoutMs].every(
        (value) => Number.isInteger(value) && value > 0 && value <= 120000,
      )
    )
      throw new Error('Invalid local embedding configuration.');
  }
  async rank(request: { query: string; candidates: NvidiaCandidate[]; signal?: AbortSignal }) {
    const parsed = Input.safeParse({ query: request.query, candidates: request.candidates });
    if (!parsed.success) throw new Error('Invalid local embedding request.');
    const input = parsed.data;
    if (
      new Set(input.candidates.map((candidate) => candidate.sourceId)).size !==
      input.candidates.length
    )
      throw new Error('Duplicate ranking source.');
    if (request.signal?.aborted) throw new Error('Local embedding cancelled.');
    if (this.pending) throw new Error('Local embedding busy.');
    const id = randomUUID();
    const raw = await new Promise<unknown>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const cleanup = () => {
        clearTimeout(timer);
        request.signal?.removeEventListener('abort', cancel);
      };
      const fail = (reason: string) => {
        cleanup();
        reject(new Error(reason));
      };
      const cancel = () => this.fail('Local embedding cancelled.');
      const arm = (milliseconds: number) => {
        clearTimeout(timer);
        timer = setTimeout(() => this.fail('Local embedding timed out.'), milliseconds);
      };
      this.pending = {
        id,
        resolve: (value) => {
          cleanup();
          resolve(value);
        },
        reject: (error) => fail(error.message),
        send: () => {
          arm(this.options.timeoutMs);
          this.child?.stdin.write(`${JSON.stringify({ id, op: 'embed', ...input })}\n`, (error) => {
            if (error) this.fail('Local embedding unavailable.');
          });
        },
      };
      arm(this.options.startupTimeoutMs);
      request.signal?.addEventListener('abort', cancel, { once: true });
      if (request.signal?.aborted) {
        cancel();
        return;
      }
      if (this.child && this.ready) this.pending.send();
      else this.start();
    });
    const reply = Reply.parse(raw);
    if (
      reply.type !== 'result' ||
      reply.id !== id ||
      reply.passages.length !== input.candidates.length ||
      reply.passages.some((item, index) => item.sourceId !== input.candidates[index]?.sourceId)
    ) {
      this.stop();
      throw new Error('Invalid local embedding response.');
    }
    const normalize = (values: number[]) => {
      const length = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
      if (!Number.isFinite(length) || length <= 0) {
        this.stop();
        throw new Error('Invalid local embedding vector.');
      }
      return values.map((value) => value / length);
    };
    const query = normalize(reply.query);
    const candidates = reply.passages
      .map((passage) => ({
        sourceId: passage.sourceId,
        score: Math.max(
          -1,
          Math.min(
            1,
            normalize(passage.embedding).reduce(
              (sum, value, index) => sum + value * (query[index] ?? 0),
              0,
            ),
          ),
        ),
      }))
      .sort((a, b) => b.score - a.score || a.sourceId.localeCompare(b.sourceId));
    return { model: MODEL, revision: REVISION, candidates };
  }
  private start() {
    const child = spawn(
      this.options.pythonPath,
      [
        this.options.scriptPath,
        '--model-dir',
        this.options.modelDirectory,
        '--device',
        this.options.device,
      ],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          PATH: '/usr/bin:/bin',
          HF_HUB_OFFLINE: '1',
          TRANSFORMERS_OFFLINE: '1',
          HF_HUB_DISABLE_IMPLICIT_TOKEN: '1',
          PYTORCH_ENABLE_MPS_FALLBACK: '0',
          TOKENIZERS_PARALLELISM: 'false',
        },
      },
    );
    this.child = child;
    this.ready = false;
    this.buffer = '';
    const decoder = new StringDecoder('utf8');
    child.stderr.resume(); // Never forward model/provider diagnostics containing selected text.
    child.stdout.on('data', (chunk: Buffer) => {
      if (this.child !== child) return;
      this.buffer += decoder.write(chunk);
      if (Buffer.byteLength(this.buffer) > 2 * 1024 * 1024) {
        this.fail('Invalid local embedding output.');
        return;
      }
      for (;;) {
        const boundary = this.buffer.indexOf('\n');
        if (boundary < 0) break;
        const line = this.buffer.slice(0, boundary);
        this.buffer = this.buffer.slice(boundary + 1);
        if (line) this.line(line);
      }
    });
    child.stdin.on('error', () => {
      if (this.child === child) this.fail('Local embedding unavailable.');
    });
    child.once('error', () => {
      if (this.child === child) this.fail('Local embedding unavailable.');
    });
    child.once('close', () => {
      if (this.child === child) this.fail('Local embedding unavailable.');
    });
  }
  private line(line: string) {
    try {
      const reply = Reply.parse(JSON.parse(line));
      if (reply.type === 'ready') {
        if (this.ready) throw new Error();
        this.ready = true;
        this.pending?.send();
        return;
      }
      if (!this.ready || !this.pending || reply.id !== this.pending.id) throw new Error();
      if (reply.type === 'error') {
        this.fail(
          reply.code === 'too_long'
            ? 'Selected text exceeds local embedding token limit.'
            : 'Local embedding unavailable.',
        );
        return;
      }
      const pending = this.pending;
      this.pending = null;
      pending.resolve(reply);
    } catch {
      this.fail('Invalid local embedding output.');
    }
  }
  private fail(message: string) {
    const pending = this.pending;
    this.pending = null;
    this.stop();
    pending?.reject(new Error(message));
  }
  private stop() {
    const child = this.child;
    this.child = null;
    this.ready = false;
    this.buffer = '';
    if (child) {
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 500);
      timer.unref();
      child.once('close', () => clearTimeout(timer));
    }
  }
  close() {
    this.fail('Local embedding closed.');
  }
}
