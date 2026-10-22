/** Shared test doubles: an in-memory Boopy with deterministic ids and time. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Boopy } from './boopy.ts';
import type { Frame, StartSessionRequest } from './contracts.ts';
import type { TextLine } from './events.ts';
import { FixtureInterpreter } from './interpret/fixture.ts';
import type { Interpreter } from './interpret/interpreter.ts';
import { Journal, MediaStore } from './journal.ts';
import type { TextReader } from './ocr.ts';
import type { Segmenter } from './segmentation.ts';
import type { SpeechEngine } from './speech.ts';
import type { SpeechOutput } from './speech-output.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export function fixtureJpeg(name: 'desert-photo.jpg' | 'korean-notes.jpg'): Buffer {
  return readFileSync(join(root, 'fixtures', 'images', name));
}

export function frameOf(name: 'desert-photo.jpg' | 'korean-notes.jpg' = 'desert-photo.jpg'): Frame {
  return {
    jpeg: fixtureJpeg(name).toString('base64'),
    width: 1280,
    height: 960,
    capturedAt: '1970-01-01T18:00:00.000Z',
  };
}

export function startRequest(said: string): StartSessionRequest & { frame: Frame } {
  return {
    frame: frameOf(),
    cues: { gaze: { point: { x: 0.45, y: 0.55 }, onSurface: true } },
    speech: { text: said },
    device: { model: 'Meta Quest 3', app: 'boopy-quest test' },
  };
}

export class FakeSpeech implements SpeechEngine {
  readonly name = 'fake speech';
  heard: { text: string; language: string } = { text: '', language: 'en' };
  async transcribe(): Promise<{ text: string; language: string }> {
    return this.heard;
  }
}

export class FakeText implements TextReader {
  readonly name = 'fake OCR';
  lines: TextLine[] = [];
  async read(): Promise<TextLine[]> {
    return this.lines;
  }
}

export function testBoopy(
  options: {
    interpreter?: Interpreter;
    journal?: Journal;
    segmenter?: Segmenter;
    speechOutput?: SpeechOutput;
  } = {},
) {
  let next = 0;
  let clock = Date.parse('1970-01-01T18:00:00.000Z');
  const journal = options.journal ?? Journal.open(':memory:');
  const media = new MediaStore(null);
  const speech = new FakeSpeech();
  const text = new FakeText();
  const deps = {
    journal,
    media,
    interpreter: options.interpreter ?? new FixtureInterpreter(),
    segmenter: options.segmenter ?? null,
    speech,
    text,
    speechOutput: options.speechOutput ?? null,
    service: 'boopy-service test',
    now: () => {
      clock += 1000;
      return new Date(clock);
    },
    newId: (prefix: string) => {
      next += 1;
      return `${prefix}_${next}`;
    },
  };
  return { boopy: new Boopy(deps), deps, journal, speech, text };
}
