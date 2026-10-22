/** Read-only checks of fixed local defaults; never imports private configuration or journals. */
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const speech = join(homedir(), '.halcyonic/speech');
type Check = {
  capability: string;
  status: 'available' | 'missing' | 'unverified';
  required: boolean;
};
type Dependencies = {
  file: (path: string, executable: boolean) => Promise<boolean>;
  fetch: typeof fetch;
  voices: () => Promise<string>;
};
const defaults: Dependencies = {
  async file(path, executable) {
    try {
      const info = await stat(path);
      await access(path, executable ? constants.R_OK | constants.X_OK : constants.R_OK);
      return info.isFile() && info.size > 0;
    } catch {
      return false;
    }
  },
  fetch,
  async voices() {
    return (
      await promisify(execFile)('/usr/bin/say', ['-v', '?'], { timeout: 3000, maxBuffer: 131072 })
    ).stdout;
  },
};
export async function demoReadiness(
  deps: Dependencies = defaults,
  env: NodeJS.ProcessEnv = process.env,
) {
  const voice = env.BOOPY_SPEECH_OUTPUT ?? 'mac-say';
  const scene = env.BOOPY_LIVE_SCENE ?? 'none';
  const capabilities: Check[] = [];
  const add = (capability: string, available: boolean, required = true) =>
    capabilities.push({ capability, status: available ? 'available' : 'missing', required });
  for (const [label, path, executable] of [
    ['Whisper executable', join(speech, 'whisper.cpp-1.9.4/bin/whisper-cli'), true],
    ['Whisper model', join(speech, 'models/ggml-large-v3-turbo-q5_0.bin'), false],
    ['Whisper VAD', join(speech, 'models/ggml-silero-v6.2.0.bin'), false],
    ['Apple Vision OCR executable', join(root, '.build/boopy-ocr'), true],
  ] as const)
    add(label, await deps.file(path, executable));
  if (voice === 'mac-say') {
    add('Mac voice executable', await deps.file('/usr/bin/say', true));
    try {
      const voices = await deps.voices();
      for (const name of ['Samantha', 'Yuna'])
        add(`${name} voice`, new RegExp(`^${name}\\s`, 'm').test(voices));
    } catch {
      add('Samantha and Yuna voices', false);
    }
  } else if (voice === 'qwen') {
    add(
      'Qwen Python installed',
      !!env.BOOPY_VOICE_PYTHON && (await deps.file(env.BOOPY_VOICE_PYTHON, true)),
    );
    for (const name of [
      'config.json',
      'model.safetensors',
      'tokenizer_config.json',
      'vocab.json',
      'merges.txt',
      'speech_tokenizer/config.json',
      'speech_tokenizer/model.safetensors',
    ])
      add(
        `Qwen ${name} installed`,
        !!env.BOOPY_VOICE_MODEL && (await deps.file(join(env.BOOPY_VOICE_MODEL, name), false)),
      );
    capabilities.push({
      capability: 'Qwen runtime synthesis (not tested by read-only readiness)',
      status: 'unverified',
      required: false,
    });
  } else if (voice !== 'none') add('Recognized speech configuration', false);
  if (scene === 'local') {
    add(
      'Local scene Python installed',
      !!env.BOOPY_SCENE_PYTHON && (await deps.file(env.BOOPY_SCENE_PYTHON, true)),
    );
    for (const [label, directory] of [
      ['detector', env.BOOPY_SCENE_DETECTOR],
      ['segmenter', env.BOOPY_SCENE_SEGMENTER],
    ] as const)
      for (const name of ['config.json', 'model.safetensors', 'preprocessor_config.json'])
        add(
          `Local scene ${label} ${name} installed`,
          !!directory && (await deps.file(join(directory, name), false)),
        );
  } else if (scene !== 'none') add('Recognized live scene configuration', false);
  try {
    // Official GET/models[].name contract: https://docs.ollama.com/api/tags.
    const response = await deps.fetch('http://127.0.0.1:11434/api/tags', {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(3000),
    });
    const value: unknown = response.ok ? await response.json() : null;
    if (!response.ok) await response.body?.cancel();
    add(
      'Default local Qwen model installed',
      value !== null &&
        typeof value === 'object' &&
        'models' in value &&
        Array.isArray(value.models) &&
        value.models.some(
          (entry: unknown) =>
            entry !== null &&
            typeof entry === 'object' &&
            'name' in entry &&
            entry.name === 'qwen3.6:35b-a3b-nvfp4',
        ),
    );
  } catch {
    add('Default local Qwen model installed', false);
  }
  let serviceHealthy = false;
  let liveProviderConfigured: boolean | null = scene === 'local' ? false : null;
  try {
    const response = await deps.fetch('http://127.0.0.1:47900/v1/health', {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(3000),
    });
    const health = response.ok
      ? ((await response.json()) as {
          ok?: unknown;
          service?: unknown;
          liveScene?: { provider?: unknown } | null;
        })
      : null;
    if (!response.ok) await response.body?.cancel();
    serviceHealthy = health?.ok === true && health?.service === 'boopy';
    if (scene === 'local')
      liveProviderConfigured = serviceHealthy && health?.liveScene?.provider === 'local';
    add('Local service health (informational)', serviceHealthy, false);
  } catch {
    add('Local service health (informational)', false, false);
  }
  capabilities.push({
    capability: 'Headset flow and wearer acceptance',
    status: 'unverified',
    required: false,
  });
  return {
    configuration: { speechOutput: voice, liveScene: scene },
    serviceHealthy,
    liveProviderConfigured,
    voiceRuntimeReady: voice === 'none' ? null : 'unverified',
    wearerAcceptance: 'unverified',
    limits:
      'File checks establish installed prerequisites only; no imports, synthesis, scene inference or wearer test.',
    providerPrerequisitesReady: capabilities.every(
      (check) => !check.required || check.status === 'available',
    ),
    capabilities,
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await demoReadiness();
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.providerPrerequisitesReady ? 0 : 1;
}
