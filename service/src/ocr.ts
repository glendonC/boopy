import { spawn } from 'node:child_process';
import type { Box } from './contracts.ts';
import type { TextLine } from './events.ts';

/** Reads text in a frame. Apple Vision here, a script in tests. */
export interface TextReader {
  readonly name: string;
  read(jpeg: Buffer): Promise<TextLine[]>;
}

/**
 * Apple Vision through `tools/ocr/main.swift`, built by `pnpm ocr:build`. Its output is the
 * record of what the text says; models interpret it but never replace it.
 */
export class VisionTextReader implements TextReader {
  readonly name = 'Apple Vision (accurate, ko-KR and en-US)';
  readonly #binary: string;

  constructor(binary: string) {
    this.#binary = binary;
  }

  read(jpeg: Buffer): Promise<TextLine[]> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.#binary, [], { env: {}, stdio: ['pipe', 'pipe', 'pipe'] });
      const out: Buffer[] = [];
      let err = '';
      child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => {
        err += chunk.toString();
      });
      const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(new Error(`OCR ended with ${code}: ${err.trim().slice(0, 300)}`));
          return;
        }
        try {
          resolve(parseLines(Buffer.concat(out).toString('utf8')));
        } catch (error) {
          reject(error);
        }
      });
      child.stdin.end(jpeg);
    });
  }
}

export function parseLines(json: string): TextLine[] {
  const parsed = JSON.parse(json) as {
    lines?: { text?: unknown; confidence?: unknown; box?: unknown }[];
  };
  const lines: TextLine[] = [];
  for (const line of parsed.lines ?? []) {
    const box = line.box;
    if (typeof line.text !== 'string' || line.text.trim() === '') continue;
    if (!Array.isArray(box) || box.length !== 4 || !box.every((v) => typeof v === 'number'))
      continue;
    const [x0, y0, x1, y1] = box as [number, number, number, number];
    const unit: Box = {
      x0: Math.max(0, Math.min(x0, x1)),
      y0: Math.max(0, Math.min(y0, y1)),
      x1: Math.min(1, Math.max(x0, x1)),
      y1: Math.min(1, Math.max(y0, y1)),
    };
    if (unit.x1 <= unit.x0 || unit.y1 <= unit.y0) continue;
    lines.push({
      text: line.text,
      confidence: typeof line.confidence === 'number' ? line.confidence : 0,
      box: unit,
    });
  }
  return lines;
}

/** The lines nearest a point first, at most `limit`, so a crowded page stays within a prompt. */
export function nearest(
  lines: readonly TextLine[],
  x: number,
  y: number,
  limit: number,
): TextLine[] {
  const distance = (line: TextLine) =>
    Math.hypot((line.box.x0 + line.box.x1) / 2 - x, (line.box.y0 + line.box.y1) / 2 - y);
  return [...lines].sort((a, b) => distance(a) - distance(b)).slice(0, limit);
}
