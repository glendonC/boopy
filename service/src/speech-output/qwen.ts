import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { SpeechOutput } from '../speech-output.ts';

/** Persistent offline neural worker; no automatic fallback or audio-device playback. */
export class QwenSpeechOutput implements SpeechOutput {
  readonly #options: {
    python: string;
    modelDirectory: string;
    worker?: string;
    timeoutMs?: number;
  };
  #child: ChildProcessWithoutNullStreams | null = null;
  #tail: Promise<void> = Promise.resolve();
  #closed = false;
  constructor(options: {
    python: string;
    modelDirectory: string;
    worker?: string;
    timeoutMs?: number;
  }) {
    if (
      !options.python ||
      !options.modelDirectory ||
      (options.timeoutMs !== undefined &&
        (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0))
    )
      throw new Error('Invalid neural speech configuration.');
    this.#options = options;
  }
  async synthesize(text: string, language: string, signal?: AbortSignal) {
    if (
      !['en', 'ko'].includes(language) ||
      !text.trim() ||
      text.length > 1200 ||
      text.includes('\0') ||
      text.includes('[[')
    )
      throw new Error('Invalid neural speech input.');
    const prior = this.#tail;
    let release: () => void = () => {};
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await waitForTurn(prior, signal);
    } catch (error) {
      // Cancelled queued work must settle promptly without letting a later turn
      // overtake the request that still owns the worker.
      void prior.then(release);
      throw error;
    }
    try {
      if (this.#closed || signal?.aborted) throw new Error('Neural speech cancelled.');
      const started = performance.now();
      const result = await this.#request(text, language, signal);
      const wav = Buffer.from(result.wav, 'base64');
      validateNeuralWav(wav);
      if (result.language !== language || result.voice !== 'qwen3-tts:Sohee')
        throw new Error('Invalid neural voice attribution.');
      return {
        wav,
        voice: result.voice,
        language,
        latencyMs: Math.round(performance.now() - started),
      };
    } finally {
      release();
    }
  }
  #request(
    text: string,
    language: string,
    signal?: AbortSignal,
  ): Promise<{ wav: string; voice: string; language: string }> {
    let child = this.#child;
    if (child === null) {
      child = spawn(
        this.#options.python,
        [
          this.#options.worker ?? fileURLToPath(new URL('./qwen-worker.py', import.meta.url)),
          this.#options.modelDirectory,
        ],
        {
          env: {
            PATH: '/usr/bin:/bin',
            HF_HUB_OFFLINE: '1',
            TRANSFORMERS_OFFLINE: '1',
            HF_HUB_DISABLE_TELEMETRY: '1',
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      this.#child = child;
      child.stderr.resume();
      child.stdin.on('error', () => {});
      child.on('error', () => {});
      child.on('close', () => {
        if (this.#child === child) this.#child = null;
      });
    }
    const active = child;
    return new Promise((resolve, reject) => {
      let output = '';
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        active.stdout.removeListener('data', data);
        active.removeListener('error', fail);
        active.removeListener('close', fail);
      };
      const fail = () => {
        cleanup();
        active.kill('SIGKILL');
        if (this.#child === active) this.#child = null;
        reject(new Error('Local neural speech unavailable.'));
      };
      const abort = () => fail();
      const timer = setTimeout(fail, this.#options.timeoutMs ?? 60000);
      const data = (chunk: Buffer) => {
        output += chunk.toString();
        if (output.length > 3 * 1024 * 1024) return fail();
        if (!output.includes('\n')) return;
        try {
          const parsed = JSON.parse(output.slice(0, output.indexOf('\n'))) as {
            wav?: unknown;
            voice?: unknown;
            language?: unknown;
          };
          if (
            typeof parsed.wav !== 'string' ||
            typeof parsed.voice !== 'string' ||
            typeof parsed.language !== 'string'
          )
            return fail();
          cleanup();
          resolve({ wav: parsed.wav, voice: parsed.voice, language: parsed.language });
        } catch {
          fail();
        }
      };
      active.stdout.on('data', data);
      active.once('error', fail);
      active.once('close', fail);
      signal?.addEventListener('abort', abort, { once: true });
      active.stdin.write(`${JSON.stringify({ text, language })}\n`, (error) => {
        if (error) fail();
      });
    });
  }
  close() {
    this.#closed = true;
    this.#child?.kill('SIGKILL');
    this.#child = null;
  }
}

function waitForTurn(prior: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return prior;
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(new Error('Neural speech cancelled.'));
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    void prior.then(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    });
  });
}

function validateNeuralWav(wav: Buffer) {
  if (
    wav.length < 44 ||
    wav.length > 2 * 1024 * 1024 ||
    wav.toString('ascii', 0, 4) !== 'RIFF' ||
    wav.toString('ascii', 8, 12) !== 'WAVE' ||
    wav.readUInt32LE(4) + 8 !== wav.length
  )
    throw new Error('Invalid neural audio.');
  let offset = 12,
    format = false,
    data = false;
  while (offset + 8 <= wav.length) {
    const name = wav.toString('ascii', offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4),
      begin = offset + 8,
      end = begin + size;
    if (end > wav.length) throw new Error('Invalid neural audio.');
    if (name === 'fmt ') {
      if (
        format ||
        size < 16 ||
        wav.readUInt16LE(begin) !== 1 ||
        wav.readUInt16LE(begin + 2) !== 1 ||
        wav.readUInt32LE(begin + 4) !== 24000 ||
        wav.readUInt32LE(begin + 8) !== 48000 ||
        wav.readUInt16LE(begin + 12) !== 2 ||
        wav.readUInt16LE(begin + 14) !== 16
      )
        throw new Error('Invalid neural PCM format.');
      format = true;
    }
    if (name === 'data') {
      if (data || size === 0 || size % 2 !== 0) throw new Error('Invalid neural PCM data.');
      data = true;
    }
    offset = end + (size % 2);
  }
  if (!format || !data || offset !== wav.length) throw new Error('Invalid neural audio.');
}
