import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import type { SessionView } from '../contracts.ts';

describe('simulator interpretation failure', () => {
  for (const model of [null, { provider: 'test', id: 'empty', latencyMs: 1 }]) {
    it(`exits before corrections, preview and commit when ${model === null ? 'the model failed' : 'no proposals arrived'}`, async (t) => {
      const directory = mkdtempSync(join(tmpdir(), 'boopy-simulate-test-'));
      t.after(() => rmSync(directory, { recursive: true, force: true }));
      const image = join(directory, 'synthetic.jpg');
      await sharp({ create: { width: 8, height: 8, channels: 3, background: '#888' } })
        .jpeg()
        .toFile(image);
      const view: SessionView = {
        id: 'failed-synthetic-session',
        state: 'review',
        scope: 'scene',
        referentId: null,
        intentId: null,
        items: [],
        relations: [],
        observations: [],
        utterances: [],
        model,
        notice: 'Could not interpret that: model request timed out',
        committed: null,
      };
      const requests: string[] = [];
      const server = createServer((request, response) => {
        requests.push(`${request.method} ${request.url}`);
        request.resume();
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(view));
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
      const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
        (resolve, reject) => {
          const child = spawn(
            process.execPath,
            [
              fileURLToPath(new URL('./simulate.ts', import.meta.url)),
              '--image',
              image,
              '--say',
              'What is this synthetic object?',
              '--headset',
              endpoint,
              '--connector',
              endpoint,
            ],
            { cwd: directory, env: { BOOPY_DATA_DIR: directory } },
          );
          let stdout = '';
          let stderr = '';
          child.stdout.on('data', (data: Buffer) => {
            stdout += data.toString();
          });
          child.stderr.on('data', (data: Buffer) => {
            stderr += data.toString();
          });
          child.on('error', reject);
          child.on('close', (code) => resolve({ code, stdout, stderr }));
        },
      );
      assert.equal(result.code, 1);
      assert.match(result.stderr, /Initial interpretation failed: Could not interpret that/);
      assert.match(result.stderr, /model request timed out/);
      assert.doesNotMatch(result.stdout, /Interpreted by|After corrections|Committed/);
      assert.deepEqual(requests, ['POST /v1/sessions']);
      assert.equal(existsSync(join(directory, '.build')), false);
      assert.deepEqual(readdirSync(directory), ['synthetic.jpg']);
    });
  }
});
