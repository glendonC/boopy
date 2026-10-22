import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { QwenSpeechOutput } from './qwen.ts';

async function fixture(mode = 'normal', timeoutMs = 1000) {
  const directory = await mkdtemp(join(tmpdir(), 'boopy-neural-test-'));
  const worker = join(directory, 'worker.mjs');
  await writeFile(
    worker,
    `import {createInterface} from 'node:readline';
    const wav=Buffer.alloc(48);wav.write('RIFF');wav.writeUInt32LE(40,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(24000,24);wav.writeUInt32LE(48000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(4,40);
    let requests=0;
    for await(const line of createInterface({input:process.stdin})){requests++; const r=JSON.parse(line);if(process.argv[2]==='hang'||r.text==='Hold synthetic request.')continue;if(process.argv[2]==='invalid')wav.writeUInt32LE(44100,24);console.log(JSON.stringify({wav:wav.toString('base64'),language:r.language,voice:'qwen3-tts:Sohee'}));}
  `,
  );
  const voice = new QwenSpeechOutput({
    python: process.execPath,
    modelDirectory: mode,
    worker,
    timeoutMs,
  });
  return {
    voice,
    close: async () => {
      voice.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
it('uses a persistent worker with exact English/Korean attribution and validated mono PCM', async () => {
  const test = await fixture();
  try {
    const results = await Promise.all([
      test.voice.synthesize('Synthetic English.', 'en'),
      test.voice.synthesize('합성 예시입니다.', 'ko'),
    ]);
    assert.deepEqual(
      results.map((r) => r.voice),
      ['qwen3-tts:Sohee', 'qwen3-tts:Sohee'],
    );
    assert.ok(results.every((r) => r.wav.length === 48 && r.latencyMs >= 0));
    test.voice.close();
    await assert.rejects(test.voice.synthesize('Closed.', 'en'));
  } finally {
    await test.close();
  }
});
it('rejects unsupported language and invalid PCM without presenting generated audio', async () => {
  const test = await fixture('invalid');
  try {
    await assert.rejects(test.voice.synthesize('Synthetic.', 'fr'), /Invalid neural speech input/);
    await assert.rejects(test.voice.synthesize('Synthetic.', 'en'), /Invalid neural PCM/);
  } finally {
    await test.close();
  }
});
it('kills a stalled worker on timeout and respects cancellation without fallback', async () => {
  const test = await fixture('hang', 50);
  try {
    await assert.rejects(test.voice.synthesize('Synthetic.', 'en'), /unavailable/);
    await assert.rejects(
      test.voice.synthesize('Synthetic.', 'en', AbortSignal.abort()),
      /cancelled/,
    );
    const abort = new AbortController();
    const pending = test.voice.synthesize('Synthetic.', 'en', abort.signal);
    setTimeout(() => abort.abort(), 10);
    await assert.rejects(pending, /unavailable/);
  } finally {
    await test.close();
  }
});
it('cancels queued speech promptly without interrupting or overtaking the active turn', async () => {
  const test = await fixture('normal', 3000);
  const activeAbort = new AbortController();
  try {
    const active = test.voice.synthesize('Hold synthetic request.', 'en', activeAbort.signal);
    const activeFailure = assert.rejects(active, /unavailable/);
    const queuedAbort = new AbortController();
    const queued = test.voice.synthesize('Cancelled synthetic request.', 'en', queuedAbort.signal);
    queuedAbort.abort();
    await Promise.race([
      assert.rejects(queued, /cancelled/),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error('Queued cancellation waited for active inference.')),
          500,
        ),
      ),
    ]);
    let nextSettled = false;
    const next = test.voice.synthesize('Next synthetic request.', 'en');
    void next.then(() => {
      nextSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(nextSettled, false, 'Cancelled queue entry released the active worker slot.');
    activeAbort.abort();
    await activeFailure;
    assert.equal((await next).wav.length, 48);
  } finally {
    activeAbort.abort();
    await test.close();
  }
});
