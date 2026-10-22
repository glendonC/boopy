import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface Heard {
  readonly text: string;
  /** The language whisper detected, as an ISO 639-1 code. */
  readonly language: string;
}

/** Turns a clip of speech into words. whisper.cpp here, a script in tests. */
export interface SpeechEngine {
  readonly name: string;
  transcribe(wav: Buffer): Promise<Heard>;
}

export interface WhisperPaths {
  readonly binary: string;
  readonly model: string;
  readonly vadModel: string;
}

/**
 * whisper.cpp's `whisper-cli`, once per clip, with automatic language detection (the person may
 * speak English or Korean) and Silero voice activity detection, so a clip without speech yields
 * no words rather than invented ones. A short clip takes about half a second.
 */
export class WhisperEngine implements SpeechEngine {
  readonly name = 'whisper.cpp large-v3-turbo';
  readonly #paths: WhisperPaths;
  readonly #timeoutMs: number;

  constructor(paths: WhisperPaths, timeoutMs = 30_000) {
    this.#paths = paths;
    this.#timeoutMs = timeoutMs;
  }

  async transcribe(wav: Buffer): Promise<Heard> {
    const directory = await mkdtemp(join(tmpdir(), 'boopy-speech-'));
    try {
      const clip = join(directory, 'clip.wav');
      await writeFile(clip, wav, { mode: 0o600 });
      const prefix = join(directory, 'out');
      await run(
        this.#paths.binary,
        [
          '-m',
          this.#paths.model,
          '-l',
          'auto',
          '-nt',
          '-np',
          '--vad',
          '-vm',
          this.#paths.vadModel,
          '-vp',
          '500',
          '-oj',
          '-of',
          prefix,
          '-f',
          clip,
        ],
        this.#timeoutMs,
      );
      const result = JSON.parse(await readFile(`${prefix}.json`, 'utf8')) as {
        result?: { language?: string };
        transcription?: { text?: string }[];
      };
      const text = (result.transcription ?? [])
        .map((segment) => segment.text ?? '')
        .join('')
        .trim();
      return { text, language: result.result?.language ?? 'und' };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

function run(binary: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { env: {}, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 4000) stderr += chunk.toString();
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else
        reject(new Error(`${binary} ended with ${signal ?? code}: ${stderr.slice(-400).trim()}`));
    });
  });
}
