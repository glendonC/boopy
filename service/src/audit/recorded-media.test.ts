/** Synthetic fixtures only. The codec case skips when existing tools are unavailable. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { inspectRecordedMedia, RecordedMediaError } from '../recorded-media.ts';

test('audit media: unequal audio and video durations are refused as documented', {
  skip: !existsSync('/opt/homebrew/bin/ffmpeg') || !existsSync('/opt/homebrew/bin/ffprobe'),
}, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'boopy-audit-media-')));
  try {
    const input = join(directory, 'synthetic-short-audio.mp4');
    const encoded = spawnSync(
      '/opt/homebrew/bin/ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-nostdin',
        '-f',
        'lavfi',
        '-i',
        'color=c=red:s=96x64:r=2:d=2',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=1000:sample_rate=48000:duration=0.5',
        '-c:v',
        'libx264',
        '-threads',
        '1',
        '-bf',
        '0',
        '-pix_fmt',
        'yuv420p',
        '-vf',
        'setsar=1',
        '-af',
        'asetpts=PTS+1024',
        '-c:a',
        'aac',
        '-use_editlist',
        '0',
        '-movflags',
        '+faststart',
        input,
      ],
      { timeout: 10_000, maxBuffer: 16_384 },
    );
    assert.equal(encoded.status, 0, 'synthetic encoder must succeed');
    const probed = spawnSync(
      '/opt/homebrew/bin/ffprobe',
      [
        '-v',
        'error',
        '-show_entries',
        'stream=codec_type,start_pts,duration',
        '-of',
        'json',
        input,
      ],
      { timeout: 5000, maxBuffer: 65_536, encoding: 'utf8' },
    );
    assert.equal(probed.status, 0, 'synthetic probe must succeed');
    const streams = JSON.parse(probed.stdout).streams as {
      codec_type: string;
      start_pts: number;
      duration: string;
    }[];
    const video = streams.find((stream) => stream.codec_type === 'video');
    const audio = streams.find((stream) => stream.codec_type === 'audio');
    assert.equal(video?.start_pts, 0);
    assert.equal(audio?.start_pts, 0);
    assert.equal(Number(video?.duration), 2);
    assert.ok(Number(audio?.duration) > 0 && Number(audio?.duration) < 1);
    await assert.rejects(
      inspectRecordedMedia(input),
      (error) => error instanceof RecordedMediaError && error.code === 'unsupported_timeline',
      'accepted audio ending over one second before its video',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('audit media: tool-free path guards run when the optional encoder is unavailable', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'boopy-audit-no-encoder-')));
  try {
    const preload = join(directory, 'missing-encoder.mjs');
    await writeFile(
      preload,
      `
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const original = childProcess.spawnSync;
childProcess.spawnSync = (file, ...args) => file === '/opt/homebrew/bin/ffmpeg'
  ? { pid: 0, output: [null, null, null], stdout: null, stderr: null, status: null,
      signal: null, error: Object.assign(new Error('Synthetic missing encoder.'), { code: 'ENOENT' }) }
  : original(file, ...args);
syncBuiltinESMExports();
`,
    );
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        preload,
        '--test',
        '--test-reporter=spec',
        '--test-name-pattern=rejects URL, network and control-containing paths before any child',
        'src/recorded-media.test.ts',
      ],
      {
        cwd: fileURLToPath(new URL('../../', import.meta.url)),
        env: { PATH: process.env.PATH ?? '', NODE_NO_WARNINGS: '1' },
        timeout: 10_000,
        maxBuffer: 65_536,
        encoding: 'utf8',
      },
    );
    if (result.status !== 0) assert.match(result.stdout, /synthetic encoder must succeed/);
    assert.equal(result.status, 0, 'tool-free guards were blocked by optional encoder setup');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
