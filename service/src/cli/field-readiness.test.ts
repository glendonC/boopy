import assert from 'node:assert/strict';
import { type AddressInfo, createServer } from 'node:net';
import { test } from 'node:test';
import { fieldReadiness, installedBaseApk, readOnlyAdb } from './field-readiness.ts';

const apk = '/data/app/~~synthetic/com.boopy.quest-synthetic/base.apk';
const hash = 'a'.repeat(64);
const env = {
  BOOPY_SPEECH_OUTPUT: 'qwen',
  BOOPY_LIVE_SCENE: 'local',
  BOOPY_VOICE_PYTHON: '/synthetic/python',
  BOOPY_VOICE_MODEL: '/synthetic/voice',
  BOOPY_SCENE_PYTHON: '/synthetic/python',
  BOOPY_SCENE_DETECTOR: '/synthetic/detector',
  BOOPY_SCENE_SEGMENTER: '/synthetic/segmenter',
};
function fixture() {
  const reads: string[] = [];
  const commands: string[][] = [];
  const deps = {
    file: async () => true,
    hashFile: async () => hash,
    voices: async () => '',
    adbRunning: async () => true,
    fetch: (async (input, options) => {
      reads.push(String(input));
      assert.equal(options?.method, 'GET');
      assert.equal(options?.redirect, 'error');
      assert.match(String(input), /^http:\/\/127\.0\.0\.1:(47900|11434)\//);
      return String(input).endsWith('/v1/health')
        ? Response.json({
            ok: true,
            service: 'boopy',
            interpreter: { provider: 'ollama', model: 'qwen3.6:35b-a3b-nvfp4' },
            speechOutputAvailable: true,
            segmenter: null,
            liveScene: { provider: 'local', model: 'synthetic' },
          })
        : Response.json({ models: [{ name: 'qwen3.6:35b-a3b-nvfp4' }] });
    }) as typeof fetch,
    adb: async (args: string[]) => {
      commands.push(args);
      if (args[0] === 'devices') return 'synthetic-quest device usb:1 product:synthetic\n';
      if (args.includes('reverse')) return 'host tcp:47900 tcp:47900\n';
      if (args.includes('pm')) return `package:${apk}\n`;
      if (args.includes('sha256sum')) return `${hash}  ${apk}\n`;
      return 'Filesystem 1K-blocks Used Available Use% Mounted\n/dev/fuse 4000000 1000 3000000 1% /sdcard\n';
    },
  };
  return { deps, reads, commands };
}
test('successful prerequisites retain unverified recording, inference, device HTTP and consumer connections', async () => {
  const { deps, commands } = fixture();
  const report = await fieldReadiness({}, deps, env);
  assert.equal(report.prerequisitesPassed, true);
  assert.equal(report.recording, 'unverified');
  assert.equal(report.inference, 'unverified');
  assert.equal(report.deviceHttp, 'unverified');
  assert.equal(report.artifactMatch, 'match');
  assert.deepEqual(report.consumerConnections, { muse: 'unverified', grok: 'unverified' });
  assert.equal(report.questOnlySupported, false);
  assert.equal(commands.length, 5);
  assert.doesNotMatch(JSON.stringify(report), /synthetic-quest|base\.apk|\/synthetic\//);
  assert.equal((await fieldReadiness({ questOnly: true }, deps, env)).prerequisitesPassed, false);
});
test('absent ADB never invokes a client or repairs a mapping; ambiguous USB never guesses', async () => {
  const { deps, commands } = fixture();
  const missing = await fieldReadiness({}, { ...deps, adbRunning: async () => false }, env);
  assert.equal(missing.prerequisitesPassed, false);
  assert.equal(commands.length, 0);
  const ambiguous = await fieldReadiness(
    {},
    { ...deps, adb: async () => 'one device usb:1\ntwo device usb:2\n' },
    env,
  );
  assert.equal(ambiguous.usbDeviceCount, 2);
  assert.equal(ambiguous.prerequisitesPassed, false);
});
test('generic health, missing profile, insufficient storage and vendor failures fail closed without diagnostics', async () => {
  const { deps } = fixture();
  assert.equal(
    (await fieldReadiness({}, { ...deps, fetch: async () => Response.json({ ok: true }) }, env))
      .prerequisitesPassed,
    false,
  );
  assert.equal((await fieldReadiness({}, deps, {})).prerequisitesPassed, false);
  assert.equal(
    (await fieldReadiness({ minStorageMiB: 4000 }, deps, env)).prerequisitesPassed,
    false,
  );
  const report = await fieldReadiness(
    {},
    {
      ...deps,
      adb: async () => {
        throw new Error('private-vendor-token');
      },
    },
    env,
  );
  assert.equal(report.prerequisitesPassed, false);
  assert.doesNotMatch(JSON.stringify(report), /private-vendor-token/);
  await assert.rejects(fieldReadiness({ minStorageMiB: -1 }, deps, env));
});
test('ADB reader allows only fixed reads and handles fragmented transport replies without spawning a server', async () => {
  const observed: string[] = [];
  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = Number.parseInt(buffer.subarray(0, 4).toString(), 16);
        if (buffer.length < length + 4) return;
        const command = buffer.subarray(4, 4 + length).toString();
        buffer = buffer.subarray(4 + length);
        observed.push(command);
        if (command.startsWith('host:transport:')) socket.write('OKAY');
        else if (command.startsWith('shell:toybox sha256sum ')) socket.end(`OKAY${hash}  ${apk}\n`);
        else if (command.startsWith('shell:')) socket.end('OKAYpackage:/synthetic/base.apk\n');
        else {
          const payload =
            command === 'host:devices-l'
              ? 'synthetic device usb:1\n'
              : 'host tcp:47900 tcp:47900\n';
          socket.write('OK');
          socket.end(`AY${Buffer.byteLength(payload).toString(16).padStart(4, '0')}${payload}`);
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    assert.match(await readOnlyAdb(['devices', '-l'], port), /usb:1/);
    assert.match(await readOnlyAdb(['-s', 'synthetic', 'reverse', '--list'], port), /47900/);
    assert.match(
      await readOnlyAdb(['-s', 'synthetic', 'shell', 'pm', 'path', 'com.boopy.quest'], port),
      /package:/,
    );
    assert.equal(
      await readOnlyAdb(['-s', 'synthetic', 'shell', 'toybox', 'sha256sum', apk], port),
      `${hash}  ${apk}\n`,
    );
    assert.throws(() => readOnlyAdb(['start-server'], port));
    assert.throws(() => readOnlyAdb(['-s', 'synthetic', 'shell', 'cat', '/private/media'], port));
    assert.deepEqual(observed, [
      'host:devices-l',
      'host:transport:synthetic',
      'reverse:list-forward',
      'host:transport:synthetic',
      'shell:pm path com.boopy.quest',
      'host:transport:synthetic',
      `shell:toybox sha256sum ${apk}`,
    ]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('APK comparison distinguishes mismatch and unavailable reads without source mapping claims', async () => {
  const { deps } = fixture();
  const mismatch = await fieldReadiness({}, { ...deps, hashFile: async () => 'b'.repeat(64) }, env);
  assert.equal(mismatch.artifactMatch, 'mismatch');
  assert.equal(mismatch.sourceMapping, 'unverified');
  assert.equal(mismatch.prerequisitesPassed, false);
  const unavailable = await fieldReadiness(
    {},
    {
      ...deps,
      hashFile: async () => {
        throw new Error('private');
      },
    },
    env,
  );
  assert.equal(unavailable.artifactMatch, 'unverified');
  assert.doesNotMatch(JSON.stringify(unavailable), /private/);
  const absent = await fieldReadiness({}, { ...deps, adbRunning: async () => false }, env);
  assert.equal(absent.artifactMatch, 'unverified');
  assert.equal(absent.checks.find((c) => c.check.startsWith('Single Boopy'))?.status, 'unverified');
});

test('APK path rejects injected, foreign, malformed and split package outputs before hashing', async () => {
  for (const output of [
    `package:${apk}\npackage:/data/app/com.boopy.quest-other/split.apk\n`,
    `package:${apk};reboot`,
    `package:${apk}\nreboot`,
    'package:/data/user/0/com.boopy.quest/private/base.apk',
    'package:/data/app/com.foreign-app/base.apk',
    'package:/data/app/com.boopy.quest-../base.apk',
    '',
  ]) {
    assert.equal(installedBaseApk(output), null);
    const { deps, commands } = fixture();
    const adb = deps.adb;
    const report = await fieldReadiness(
      {},
      { ...deps, adb: async (args) => (args.includes('pm') ? output : adb(args)) },
      env,
    );
    assert.equal(report.artifactMatch, 'unverified');
    assert.equal(
      commands.some((args) => args.includes('sha256sum')),
      false,
    );
  }
  assert.equal(installedBaseApk(`package:${apk}\n`), apk);
  assert.throws(() =>
    readOnlyAdb(['-s', 'synthetic', 'shell', 'toybox', 'sha256sum', `${apk};reboot`]),
  );
});

test('ADB hash read rejects oversized output within existing protocol bounds', async () => {
  const server = createServer((socket) => {
    let calls = 0;
    socket.on('data', () => {
      calls++;
      if (calls === 1) socket.write('OKAY');
      else socket.end(`OKAY${'x'.repeat(32769)}`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await assert.rejects(
      readOnlyAdb(
        ['-s', 'synthetic', 'shell', 'toybox', 'sha256sum', apk],
        (server.address() as AddressInfo).port,
      ),
      /unavailable/,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('APK hash response must bind the exact validated file, not diagnostic text or another path', async () => {
  for (const output of [
    `${hash}  /private/other.apk\n`,
    `${hash}  ${apk}\nextra`,
    'vendor-token-error',
  ]) {
    const { deps } = fixture();
    const adb = deps.adb;
    const result = await fieldReadiness(
      {},
      { ...deps, adb: async (args) => (args.includes('sha256sum') ? output : adb(args)) },
      env,
    );
    assert.equal(result.artifactMatch, 'unverified');
    assert.doesNotMatch(JSON.stringify(result), /vendor-token-error|other.apk/);
  }
});

test('APK checksum accepts only exact no-newline, LF or legacy CRLF framing', async () => {
  for (const ending of ['', '\n', '\r\n', '\n\n', '\r\nextra', ' ']) {
    const { deps } = fixture();
    const adb = deps.adb;
    const report = await fieldReadiness(
      {},
      {
        ...deps,
        adb: async (args) => (args.includes('sha256sum') ? `${hash}  ${apk}${ending}` : adb(args)),
      },
      env,
    );
    assert.equal(
      report.artifactMatch,
      ['', '\n', '\r\n'].includes(ending) ? 'match' : 'unverified',
    );
  }
});

test('unreadable reverse metadata remains unknown while an observed missing mapping is missing', async () => {
  for (const unreadable of [true, false]) {
    const { deps } = fixture();
    const adb = deps.adb;
    const report = await fieldReadiness(
      {},
      {
        ...deps,
        adb: async (args) => {
          if (!args.includes('reverse')) return adb(args);
          if (unreadable) throw new Error('private');
          return '';
        },
      },
      env,
    );
    assert.equal(
      report.checks.find((c) => c.check === 'Boopy USB reverse 47900')?.status,
      unreadable ? 'unverified' : 'missing',
    );
  }
});
