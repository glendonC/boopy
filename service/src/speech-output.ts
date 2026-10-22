import { spawn } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface SpeechOutput {
  synthesize(
    text: string,
    language: string,
    signal?: AbortSignal,
  ): Promise<{
    wav: Buffer;
    voice: string;
    language: string;
    latencyMs: number;
  }>;
}
export type SayRunner = (input: {
  args: readonly string[];
  text: string;
  signal: AbortSignal;
}) => Promise<void>;

/** Local file-only synthesis; caller must select text from a journaled Boopy response. */
export class MacSayOutput implements SpeechOutput {
  readonly #timeoutMs: number;
  readonly #maxOutputBytes: number;
  readonly #run: SayRunner;
  constructor(options: { timeoutMs?: number; maxOutputBytes?: number; run?: SayRunner } = {}) {
    this.#timeoutMs = options.timeoutMs ?? 5000;
    this.#maxOutputBytes = options.maxOutputBytes ?? 2 * 1024 * 1024;
    this.#run = options.run ?? runSay;
    if (
      !Number.isFinite(this.#timeoutMs) ||
      this.#timeoutMs <= 0 ||
      !Number.isInteger(this.#maxOutputBytes) ||
      this.#maxOutputBytes < 44
    )
      throw new Error('Invalid speech output bounds.');
  }
  async synthesize(text: string, language: string, signal?: AbortSignal) {
    const voice = language === 'en' ? 'Samantha' : language === 'ko' ? 'Yuna' : null;
    if (voice === null) throw new Error('Unsupported speech output language.');
    if (!text.trim() || text.length > 1200 || text.includes('\0') || text.includes('[['))
      throw new Error('Invalid speech output text.');
    if (signal?.aborted) throw new Error('Speech output cancelled.');
    const started = performance.now();
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.#timeoutMs);
    let directory: string | undefined;
    try {
      directory = await mkdtemp(join(tmpdir(), 'boopy-speech-output-'));
      await chmod(directory, 0o700);
      const path = join(directory, 'response.wav');
      if (signal?.aborted) controller.abort();
      await this.#run({
        args: [
          '-v',
          voice,
          '-o',
          path,
          '--file-format=WAVE',
          '--data-format=LEI16@22050',
          '--channels=1',
          '-f',
          '-',
        ],
        text,
        signal: controller.signal,
      });
      if (controller.signal.aborted) throw new Error('cancelled');
      const metadata = await stat(path);
      if (!metadata.isFile() || metadata.size > this.#maxOutputBytes) throw new Error('size');
      const wav = await readFile(path);
      validateWav(wav, this.#maxOutputBytes);
      if (controller.signal.aborted) throw new Error('cancelled');
      return { wav, voice, language, latencyMs: Math.round(performance.now() - started) };
    } catch {
      throw new Error(
        timedOut
          ? 'Speech output timed out.'
          : signal?.aborted
            ? 'Speech output cancelled.'
            : 'Speech output failed.',
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (directory !== undefined) await rm(directory, { recursive: true, force: true });
    }
  }
}

function runSay(input: Parameters<SayRunner>[0]): Promise<void> {
  return new Promise((resolve, reject) => {
    if (input.signal.aborted) {
      reject(new Error('cancelled'));
      return;
    }
    const child = spawn('/usr/bin/say', [...input.args], {
      env: {},
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    const abort = () => child.kill('SIGKILL');
    input.signal.addEventListener('abort', abort, { once: true });
    child.stdin.on('error', () => {
      child.kill('SIGKILL');
    });
    child.on('error', () => {
      input.signal.removeEventListener('abort', abort);
      reject(new Error('process'));
    });
    child.on('close', (code) => {
      input.signal.removeEventListener('abort', abort);
      if (code === 0 && !input.signal.aborted) resolve();
      else reject(new Error('process'));
    });
    if (input.signal.aborted) abort();
    child.stdin.end(input.text, 'utf8');
  });
}

/** RIFF chunk parsing accepts extra metadata but requires exact mono PCM16 22050Hz. */
function validateWav(wav: Buffer, maxBytes: number): void {
  if (
    wav.length < 44 ||
    wav.length > maxBytes ||
    wav.toString('ascii', 0, 4) !== 'RIFF' ||
    wav.toString('ascii', 8, 12) !== 'WAVE' ||
    wav.readUInt32LE(4) + 8 !== wav.length
  )
    throw new Error('wav');
  let format = false,
    data = false;
  let offset = 12;
  while (offset + 8 <= wav.length) {
    const name = wav.toString('ascii', offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const begin = offset + 8,
      end = begin + size;
    if (end > wav.length) throw new Error('wav');
    if (name === 'fmt ') {
      if (
        format ||
        size < 16 ||
        wav.readUInt16LE(begin) !== 1 ||
        wav.readUInt16LE(begin + 2) !== 1 ||
        wav.readUInt32LE(begin + 4) !== 22050 ||
        wav.readUInt32LE(begin + 8) !== 44100 ||
        wav.readUInt16LE(begin + 12) !== 2 ||
        wav.readUInt16LE(begin + 14) !== 16
      )
        throw new Error('wav');
      format = true;
    }
    if (name === 'data') {
      if (data || size === 0 || size % 2 !== 0) throw new Error('wav');
      data = true;
    }
    offset = end + (size % 2);
  }
  if (!format || !data || offset !== wav.length) throw new Error('wav');
}
