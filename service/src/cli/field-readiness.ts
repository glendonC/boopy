/** Read-only Mac/USB field preflight. Never captures, starts services, infers, or reads journals. */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { demoReadiness } from './demo-readiness.ts';

type Dependencies = Parameters<typeof demoReadiness>[0] & {
  hashFile: (path: string) => Promise<string>;
  adbRunning: () => Promise<boolean>;
  adb: (args: string[]) => Promise<string>;
};
const root = fileURLToPath(new URL('../..', import.meta.url));
const defaults: Dependencies = {
  fetch,
  async hashFile(path) {
    const hash = createHash('sha256');
    const stream = createReadStream(path, { signal: AbortSignal.timeout(10000) });
    let bytes = 0;
    for await (const chunk of stream) {
      bytes += chunk.length;
      if (bytes > 1024 * 1024 * 1024) {
        stream.destroy();
        throw new Error('APK exceeds bound.');
      }
      hash.update(chunk);
    }
    if (bytes === 0) throw new Error('Empty APK.');
    return hash.digest('hex');
  },
  async file(path, executable) {
    try {
      const info = await stat(path);
      await access(path, executable ? constants.R_OK | constants.X_OK : constants.R_OK);
      return info.isFile() && info.size > 0;
    } catch {
      return false;
    }
  },
  async voices() {
    return (
      await promisify(execFile)('/usr/bin/say', ['-v', '?'], { timeout: 3000, maxBuffer: 131072 })
    ).stdout;
  },
  adbRunning: () =>
    new Promise((resolve) => {
      const socket = createConnection({ host: '127.0.0.1', port: 5037 });
      const finish = (available: boolean) => {
        socket.destroy();
        resolve(available);
      };
      socket.setTimeout(500, () => finish(false));
      socket.once('error', () => finish(false));
      socket.once('connect', () => finish(true));
    }),
  adb: readOnlyAdb,
};

/** Only the single base APK of this package may enter the device hash command. */
const baseApkPath =
  /^\/data\/app\/(?:~~[A-Za-z0-9_+=-]+\/)?com\.boopy\.quest-[A-Za-z0-9_+=-]+\/base\.apk$/;
export function installedBaseApk(output: string): string | null {
  const lines = output.trim().split('\n');
  if (lines.length !== 1 || !lines[0]?.startsWith('package:')) return null;
  const path = lines[0].slice(8);
  return baseApkPath.test(path) ? path : null;
}

/** Fixed ADB smart-socket reads avoid CLI auto-start/version-restart side effects entirely. */
export function readOnlyAdb(args: string[], port = 5037): Promise<string> {
  let commands: string[];
  let framed = true;
  if (args.join(' ') === 'devices -l') commands = ['host:devices-l'];
  else {
    const serial = args[1];
    const operation = args.slice(2).join(' ');
    if (args[0] !== '-s' || !serial || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(serial))
      throw new Error('Unsupported ADB read.');
    const service =
      operation === 'reverse --list'
        ? 'reverse:list-forward'
        : operation === 'shell pm path com.boopy.quest'
          ? 'shell:pm path com.boopy.quest'
          : operation === 'shell df -k /sdcard'
            ? 'shell:df -k /sdcard'
            : args.length === 6 &&
                args[2] === 'shell' &&
                args[3] === 'toybox' &&
                args[4] === 'sha256sum' &&
                baseApkPath.test(args[5] ?? '')
              ? `shell:toybox sha256sum ${args[5]}`
              : null;
    if (!service) throw new Error('Unsupported ADB read.');
    commands = [`host:transport:${serial}`, service];
    framed = operation === 'reverse --list';
  }
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    let buffer = Buffer.alloc(0);
    let index = 0;
    let state: 'status' | 'length' | 'data' | 'raw' = 'status';
    let length = 0;
    let finished = false;
    const finish = (value?: string) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.destroy();
      if (value === undefined) reject(new Error('Local ADB read unavailable.'));
      else resolve(value);
    };
    const timer = setTimeout(() => finish(), 3000);
    const send = () => {
      const command = commands[index];
      if (command === undefined) {
        finish();
        return;
      }
      socket.write(Buffer.byteLength(command).toString(16).padStart(4, '0') + command);
    };
    socket.once('connect', send);
    socket.once('error', () => finish());
    socket.once('end', () => finish(state === 'raw' ? buffer.toString('utf8') : undefined));
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 32768) {
        finish();
        return;
      }
      for (;;) {
        if (state === 'raw') return;
        if (state === 'status') {
          if (buffer.length < 4) return;
          if (buffer.subarray(0, 4).toString() !== 'OKAY') {
            finish();
            return;
          }
          buffer = buffer.subarray(4);
          if (++index < commands.length) {
            send();
            continue;
          }
          state = framed ? 'length' : 'raw';
        }
        if (state === 'length') {
          if (buffer.length < 4) return;
          const header = buffer.subarray(0, 4).toString();
          if (!/^[a-fA-F0-9]{4}$/.test(header)) {
            finish();
            return;
          }
          length = Number.parseInt(header, 16);
          if (length > 32768) {
            finish();
            return;
          }
          buffer = buffer.subarray(4);
          state = 'data';
        }
        if (state === 'data') {
          if (buffer.length < length) return;
          finish(buffer.subarray(0, length).toString('utf8'));
          return;
        }
      }
    });
  });
}

async function metadata(fetcher: typeof fetch, url: string): Promise<unknown> {
  const response = await fetcher(url, {
    method: 'GET',
    redirect: 'error',
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > 65536) throw new Error();
      chunks.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    await reader.cancel();
    throw new Error();
  } finally {
    reader.releaseLock();
  }
}
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

export async function fieldReadiness(
  options: { questOnly?: boolean; minStorageMiB?: number } = {},
  deps: Dependencies = defaults,
  env: NodeJS.ProcessEnv = process.env,
) {
  const reserve = options.minStorageMiB ?? 1024;
  if (!Number.isSafeInteger(reserve) || reserve < 1 || reserve > 2 * 1024 * 1024)
    throw new Error('Choose a positive storage reserve.');
  const selectedSerial = env.BOOPY_QUEST_SERIAL;
  if (selectedSerial !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(selectedSerial))
    throw new Error('Invalid headset selection.');
  const checks: {
    check: string;
    status: 'available' | 'missing' | 'unverified';
    required: boolean;
  }[] = [];
  const add = (check: string, available: boolean, required = true) =>
    checks.push({ check, status: available ? 'available' : 'missing', required });
  add('Mac and USB deployment (Quest-only is unsupported)', options.questOnly !== true);
  const prerequisites = await demoReadiness(deps, env);
  for (const entry of prerequisites.capabilities)
    if (entry.capability !== 'Default local Qwen model installed')
      checks.push({ check: entry.capability, status: entry.status, required: entry.required });
  // Require explicit current selections instead of silently checking the older MacSay baseline.
  add(
    'Explicit local neural voice and scene profile',
    env.BOOPY_SPEECH_OUTPUT === 'qwen' && env.BOOPY_LIVE_SCENE === 'local',
  );
  const expectedModel = env.BOOPY_OLLAMA_MODEL ?? 'qwen3.6:35b-a3b-nvfp4';
  try {
    const inventory = object(await metadata(deps.fetch, 'http://127.0.0.1:11434/api/tags'));
    add(
      'Selected local interpretation model installed',
      Array.isArray(inventory?.models) &&
        inventory.models.some((entry) => object(entry)?.name === expectedModel),
    );
  } catch {
    add('Selected local interpretation model installed', false);
  }
  let health: Record<string, unknown> | null = null;
  try {
    health = object(await metadata(deps.fetch, 'http://127.0.0.1:47900/v1/health'));
  } catch {
    /* Fixed status only. */
  }
  const interpreter = object(health?.interpreter);
  const valid = health?.ok === true && health?.service === 'boopy';
  add(
    'Boopy service with exact local interpreter',
    valid && interpreter?.provider === 'ollama' && interpreter.model === expectedModel,
  );
  add('Configured neural voice available', valid && health?.speechOutputAvailable === true);
  const scene = object(health?.liveScene);
  add(
    'Configured local scene available',
    valid &&
      scene?.provider === 'local' &&
      typeof scene.model === 'string' &&
      scene.model.length > 0,
  );
  add('No hosted conversation segmentation configured', valid && health?.segmenter === null);
  try {
    const inventory = object(await metadata(deps.fetch, 'http://127.0.0.1:11434/api/ps'));
    add(
      'Selected local model resident (not inference proof)',
      Array.isArray(inventory?.models) &&
        inventory.models.some((entry) => object(entry)?.name === expectedModel),
      false,
    );
  } catch {
    add('Selected local model resident (not inference proof)', false, false);
  }
  add('Local APK readable', await deps.file(join(root, '../quest/Builds/Boopy.apk'), false));
  let artifactMatch: 'match' | 'mismatch' | 'unverified' = 'unverified';
  let deviceCount = 0;
  let freeStorageMiB: number | null = null;
  let usb = false,
    reverse = false,
    installed = false;
  let reverseObserved = false;
  let server = false;
  try {
    server = await deps.adbRunning();
  } catch {
    /* No ADB invocation on failure. */
  }
  if (server) {
    try {
      const rows = (await deps.adb(['devices', '-l']))
        .split('\n')
        .map((line) => line.trim().split(/\s+/))
        .filter((parts) => parts[1] === 'device' && parts.some((part) => part.startsWith('usb:')));
      deviceCount = rows.length;
      const chosen = selectedSerial
        ? rows.find((parts) => parts[0] === selectedSerial)
        : rows.length === 1
          ? rows[0]
          : undefined;
      const serial = chosen?.[0];
      if (serial && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(serial)) {
        usb = true;
        const prefix = ['-s', serial];
        const mappings = await deps.adb([...prefix, 'reverse', '--list']);
        reverseObserved = true;
        reverse = mappings.split('\n').some((line) => {
          const parts = line.trim().split(/\s+/);
          return parts[1] === 'tcp:47900' && parts[2] === 'tcp:47900';
        });
        const packageOutput = await deps.adb([...prefix, 'shell', 'pm', 'path', 'com.boopy.quest']);
        const apkPath = installedBaseApk(packageOutput);
        installed = apkPath !== null;
        if (apkPath !== null) {
          try {
            const output = await deps.adb([...prefix, 'shell', 'toybox', 'sha256sum', apkPath]);
            const candidate = /^([a-fA-F0-9]{64}) {2}/.exec(output)?.[1];
            const installedHash =
              candidate &&
              (output === `${candidate}  ${apkPath}` ||
                output === `${candidate}  ${apkPath}\n` ||
                output === `${candidate}  ${apkPath}\r\n`)
                ? candidate.toLowerCase()
                : undefined;
            const localHash = await deps.hashFile(join(root, '../quest/Builds/Boopy.apk'));
            if (installedHash && /^[a-f0-9]{64}$/.test(localHash))
              artifactMatch = installedHash === localHash ? 'match' : 'mismatch';
          } catch {
            /* Unsupported hash or unavailable artifact remains unknown. */
          }
        }
        const row = (await deps.adb([...prefix, 'shell', 'df', '-k', '/sdcard']))
          .trim()
          .split('\n')
          .at(-1)
          ?.trim()
          .split(/\s+/);
        if (row?.[3] && /^\d+$/.test(row[3])) {
          const value = Number(row[3]);
          if (Number.isSafeInteger(value)) freeStorageMiB = Math.floor(value / 1024);
        }
      }
    } catch {
      /* Preserve completed aggregate checks, never provider output. */
    }
  }
  add('Existing local ADB server', server);
  add('One explicitly selected or unambiguous authorized USB headset', usb);
  checks.push({
    check: 'Boopy USB reverse 47900',
    status: reverse ? 'available' : reverseObserved ? 'missing' : 'unverified',
    required: true,
  });
  checks.push({
    check: 'Single Boopy base APK located (launch unverified)',
    status: installed ? 'available' : 'unverified',
    required: true,
  });
  checks.push({
    check: 'Installed APK matches local APK',
    status:
      artifactMatch === 'match'
        ? 'available'
        : artifactMatch === 'mismatch'
          ? 'missing'
          : 'unverified',
    required: true,
  });
  checks.push({
    check: 'Headset free storage meets chosen reserve',
    status:
      freeStorageMiB === null ? 'unverified' : freeStorageMiB >= reserve ? 'available' : 'missing',
    required: true,
  });
  return {
    mode: 'read-only-mac-usb-field-preflight',
    prerequisitesPassed: checks.every((entry) => !entry.required || entry.status === 'available'),
    questOnlySupported: false,
    inference: 'unverified',
    deviceHttp: 'unverified',
    recording: 'unverified',
    wearerAcceptance: 'unverified',
    consumerConnections: { muse: 'unverified', grok: 'unverified' },
    artifactMatch,
    sourceMapping: 'unverified',
    usbDeviceCount: deviceCount,
    freeStorageMiB,
    chosenStorageReserveMiB: reserve,
    limits:
      'Prerequisites only. No model call, capture, recording, account delivery or source-checkpoint mapping is proven. APK match is only a bounded artifact comparison. No service or USB mapping is changed.',
    checks,
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({
      options: { 'quest-only': { type: 'boolean' }, 'min-storage-mib': { type: 'string' } },
    });
    const result = await fieldReadiness({
      questOnly: values['quest-only'],
      minStorageMiB:
        values['min-storage-mib'] === undefined ? undefined : Number(values['min-storage-mib']),
    });
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.prerequisitesPassed ? 0 : 1;
  } catch {
    console.error(
      'Field preflight could not finish. Check local selections; no capture or connection is claimed.',
    );
    process.exitCode = 1;
  }
}
