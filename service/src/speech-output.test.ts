import assert from 'node:assert/strict';
import { access, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { it } from 'node:test';
import { MacSayOutput, type SayRunner } from './speech-output.ts';

function wav() {
  const data = Buffer.alloc(48);
  data.write('RIFF');
  data.writeUInt32LE(40, 4);
  data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(22050, 24);
  data.writeUInt32LE(44100, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write('data', 36);
  data.writeUInt32LE(4, 40);
  return data;
}
function output(args: readonly string[]) {
  const path = args[args.indexOf('-o') + 1];
  assert.ok(path);
  return path;
}

it('uses explicit file-only voices and stdin text with private disposable output', async () => {
  const paths: string[] = [];
  const text = 'Synthetic $() phrase without shell execution.';
  const run: SayRunner = async (input) => {
    const path = output(input.args);
    paths.push(path);
    assert.equal((await stat(dirname(path))).mode & 0o777, 0o700);
    assert.equal(input.text, text);
    assert.ok(!input.args.includes(text));
    assert.deepEqual(input.args.slice(-2), ['-f', '-']);
    assert.ok(input.args.includes('--file-format=WAVE'));
    assert.ok(!input.args.includes('-a') && !input.args.includes('-n'));
    await writeFile(path, wav());
  };
  const engine = new MacSayOutput({ run });
  for (const [language, voice] of [
    ['en', 'Samantha'],
    ['ko', 'Yuna'],
  ]) {
    const result = await engine.synthesize(text, language ?? '');
    assert.equal(result.voice, voice);
    assert.equal(result.language, language);
    assert.deepEqual(result.wav, wav());
    assert.ok(result.latencyMs >= 0);
  }
  for (const path of paths) await assert.rejects(access(dirname(path)));
});

it('rejects unsupported/invalid input before running and sanitizes process errors', async () => {
  let count = 0,
    path = '';
  const engine = new MacSayOutput({
    run: async (input) => {
      count++;
      path = output(input.args);
      throw new Error(`PRIVATE ${input.text}`);
    },
  });
  for (const [text, language] of [
    ['hello', 'fr'],
    ['', 'en'],
    ['x'.repeat(1201), 'en'],
    ['bad\0text', 'en'],
    ['Hello [[slnc 200]] World', 'en'],
  ])
    await assert.rejects(engine.synthesize(text ?? '', language ?? ''));
  assert.equal(count, 0);
  await assert.rejects(engine.synthesize('synthetic secret', 'en'), {
    message: 'Speech output failed.',
  });
  await assert.rejects(access(dirname(path)));
});

it('rejects malformed, wrong-format and oversized WAV and always cleans temporary files', async () => {
  for (const kind of ['malformed', 'stereo', 'oversize']) {
    let path = '';
    const engine = new MacSayOutput({
      maxOutputBytes: 64,
      run: async (input) => {
        path = output(input.args);
        const data =
          kind === 'oversize'
            ? Buffer.alloc(65)
            : kind === 'malformed'
              ? Buffer.from('bad')
              : wav();
        if (kind === 'stereo') data.writeUInt16LE(2, 22);
        await writeFile(path, data);
      },
    });
    await assert.rejects(engine.synthesize('synthetic', 'en'), {
      message: 'Speech output failed.',
    });
    await assert.rejects(access(dirname(path)));
  }
});

it('cancels before launch and aborts running work on timeout or wearer cancellation', {
  timeout: 3000,
}, async () => {
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(
    new MacSayOutput({
      run: async () => {
        assert.fail('must not run');
      },
    }).synthesize('synthetic', 'en', cancelled.signal),
    /cancelled/,
  );
  for (const timeout of [true, false]) {
    let path = '';
    const external = new AbortController();
    const engine = new MacSayOutput({
      timeoutMs: timeout ? 10 : 1000,
      run: (input) => {
        path = output(input.args);
        return new Promise((_, reject) => {
          // Directory setup may outlast the deadline under load. An already-aborted signal
          // dispatches no new event; match the real runner's entry guard.
          if (input.signal.aborted) {
            reject(new Error('private stderr'));
            return;
          }
          input.signal.addEventListener('abort', () => reject(new Error('private stderr')), {
            once: true,
          });
          if (!timeout) external.abort();
        });
      },
    });
    await assert.rejects(engine.synthesize('synthetic', 'en', external.signal), {
      message: timeout ? 'Speech output timed out.' : 'Speech output cancelled.',
    });
    await assert.rejects(access(dirname(path)));
  }
});

it('accepts the full 1200-character response boundary and rejects one extra character before synthesis', async () => {
  let calls = 0;
  const text = 'x'.repeat(1200);
  const engine = new MacSayOutput({
    run: async (input) => {
      calls++;
      assert.equal(input.text, text);
      await writeFile(output(input.args), wav());
    },
  });
  assert.deepEqual((await engine.synthesize(text, 'en')).wav, wav());
  await assert.rejects(engine.synthesize('x'.repeat(1201), 'en'), /Invalid speech output text/);
  assert.equal(calls, 1);
});
