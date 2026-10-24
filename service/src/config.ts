import { randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OllamaActivityAssistant } from './activity-ollama.ts';

/** Headset 47900 and connector 47901, leaving 47800 and 47801 free. */
export const HEADSET_PORT = 47900;
export const CONNECTOR_PORT = 47901;

export interface Config {
  readonly activityAssistant: {
    readonly kind: 'ollama';
    readonly url: string;
    readonly model: string;
  } | null;
  readonly dataDir: string;
  readonly headsetPort: number;
  readonly connectorPort: number;
  readonly connectorBaseUrl: string;
  readonly interpreter:
    | { readonly kind: 'fixture' }
    | {
        readonly kind: 'ollama';
        readonly url: string;
        readonly model: string;
        readonly think: boolean;
      }
    | { readonly kind: 'muse-spark'; readonly apiKey: string; readonly model: string };
  readonly segmenter: { readonly kind: 'sam'; readonly apiKey: string } | null;
  readonly whisper: {
    readonly binary: string;
    readonly model: string;
    readonly vadModel: string;
  } | null;
  readonly ocrBinary: string | null;
  readonly logger: boolean;
  /**
   * The local routes for a reply from a named connection. Off until the headset can say which
   * connection a reply came through; before that, it would show under Boopy's own name.
   */
  readonly connectionReplies: boolean;
  readonly memory: 'none' | 'hmem';
  readonly semanticMemory: {
    pythonPath: string;
    modelDirectory: string;
    device: 'cpu' | 'mps';
  } | null;
  readonly speechOutput: 'none' | 'mac-say' | 'qwen';
  readonly neuralVoice: { python: string; modelDirectory: string } | null;
  readonly liveScene: { python: string; detectorModel: string; segmenterModel: string } | null;
  readonly referenceCredentialFile?: string;
}

const serviceRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** whisper.cpp under ~/.halcyonic/speech, when that directory exists. */
const HALCYONIC_SPEECH = join(homedir(), '.halcyonic', 'speech');

/** Reads configuration from the environment and the service's private key file. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = env.BOOPY_DATA_DIR ?? join(homedir(), '.boopy');
  const connectorPort = port(env.BOOPY_CONNECTOR_PORT, CONNECTOR_PORT);
  return {
    dataDir,
    headsetPort: port(env.BOOPY_PORT, HEADSET_PORT),
    connectorPort,
    connectorBaseUrl: (env.BOOPY_CONNECTOR_URL ?? `http://127.0.0.1:${connectorPort}`).replace(
      /\/$/,
      '',
    ),
    interpreter: interpreterConfig(env, dataDir),
    activityAssistant: activityAssistantConfig(env),
    segmenter: segmenterConfig(env, dataDir),
    whisper: whisperConfig(env),
    ocrBinary: env.BOOPY_OCR_BIN ?? existing(join(serviceRoot, '.build', 'boopy-ocr')),
    memory: memoryConfig(env.BOOPY_MEMORY),
    semanticMemory: semanticMemoryConfig(env),
    speechOutput: speechOutputConfig(env.BOOPY_SPEECH_OUTPUT),
    neuralVoice:
      env.BOOPY_SPEECH_OUTPUT === 'qwen'
        ? {
            python: required(env, 'BOOPY_VOICE_PYTHON'),
            modelDirectory: required(env, 'BOOPY_VOICE_MODEL'),
          }
        : null,
    liveScene: liveSceneConfig(env),
    referenceCredentialFile:
      env.BOOPY_ZETARIS_REFERENCE_CREDENTIAL_FILE === undefined
        ? undefined
        : required(env, 'BOOPY_ZETARIS_REFERENCE_CREDENTIAL_FILE'),
    logger: env.BOOPY_LOG !== '0',
    connectionReplies: env.BOOPY_CONNECTION_REPLIES === '1',
  };
}

function activityAssistantConfig(env: NodeJS.ProcessEnv): Config['activityAssistant'] {
  const kind = env.BOOPY_ACTIVITY_ASSISTANT ?? 'ollama';
  if (kind === 'none') return null;
  if (kind !== 'ollama') throw new Error('BOOPY_ACTIVITY_ASSISTANT must be ollama or none.');
  const url = env.BOOPY_OLLAMA_URL ?? 'http://127.0.0.1:11434';
  const assistant = new OllamaActivityAssistant({
    url,
    ...(env.BOOPY_ACTIVITY_MODEL === undefined ? {} : { model: env.BOOPY_ACTIVITY_MODEL }),
  });
  return { kind, url, model: assistant.model };
}

function segmenterConfig(env: NodeJS.ProcessEnv, dataDir: string): Config['segmenter'] {
  const kind = env.BOOPY_SEGMENTER ?? 'none';
  if (kind === 'none') return null;
  if (kind === 'sam') return { kind, apiKey: modelApiKey(env, dataDir) };
  throw new Error('BOOPY_SEGMENTER must be none or sam.');
}

function interpreterConfig(env: NodeJS.ProcessEnv, dataDir: string): Config['interpreter'] {
  const kind = env.BOOPY_INTERPRETER ?? 'ollama';
  switch (kind) {
    case 'fixture':
      return { kind };
    case 'ollama':
      return {
        kind,
        url: env.BOOPY_OLLAMA_URL ?? 'http://127.0.0.1:11434',
        model: env.BOOPY_OLLAMA_MODEL ?? 'qwen3.6:35b-a3b-nvfp4',
        think: env.BOOPY_OLLAMA_THINK === '1',
      };
    case 'muse-spark': {
      const apiKey = modelApiKey(env, dataDir);
      return { kind, apiKey, model: env.BOOPY_MUSE_MODEL ?? 'muse-spark-1.3' };
    }
    default:
      throw new Error(`BOOPY_INTERPRETER must be fixture, ollama or muse-spark, not ${kind}.`);
  }
}

function modelApiKey(env: NodeJS.ProcessEnv, dataDir: string): string {
  if (env.MODEL_API_KEY !== undefined) {
    if (env.MODEL_API_KEY.trim() === '') {
      throw new Error('MODEL_API_KEY is empty (Meta Model API).');
    }
    return env.MODEL_API_KEY;
  }

  const path = join(dataDir, 'model-api-key');
  let file: number;
  try {
    file = openSync(path, 'r');
  } catch {
    throw new Error(`Meta Model API needs MODEL_API_KEY or a readable ${path} (mode 0600).`);
  }
  try {
    const stat = fstatSync(file);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) {
      throw new Error(`${path} must be a regular file with mode 0600.`);
    }
    let apiKey: string;
    try {
      apiKey = readFileSync(file, 'utf8').trim();
    } catch {
      throw new Error(`Could not read ${path} (Meta Model API key).`);
    }
    if (apiKey === '') throw new Error(`${path} is empty (Meta Model API key).`);
    return apiKey;
  } finally {
    closeSync(file);
  }
}

function whisperConfig(env: NodeJS.ProcessEnv): Config['whisper'] {
  const binary =
    env.BOOPY_WHISPER_BIN ??
    existing(join(HALCYONIC_SPEECH, 'whisper.cpp-1.9.4', 'bin', 'whisper-cli'));
  const model =
    env.BOOPY_WHISPER_MODEL ??
    existing(join(HALCYONIC_SPEECH, 'models', 'ggml-large-v3-turbo-q5_0.bin'));
  const vadModel =
    env.BOOPY_WHISPER_VAD_MODEL ??
    existing(join(HALCYONIC_SPEECH, 'models', 'ggml-silero-v6.2.0.bin'));
  return binary === null || model === null || vadModel === null
    ? null
    : { binary, model, vadModel };
}

const existing = (path: string) => (existsSync(path) ? path : null);

function port(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535)
    throw new Error(`Bad port ${value}.`);
  return parsed;
}

/** The connector's bearer token: created once, mode 0600, in the data directory. */
export function connectorToken(dataDir: string): string {
  const path = join(dataDir, 'connector-token');
  if (existsSync(path)) return readFileSync(path, 'utf8').trim();
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString('base64url');
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  return token;
}

function memoryConfig(value: string | undefined): 'none' | 'hmem' {
  if (value === undefined || value === 'none') return 'none';
  if (value === 'hmem') return 'hmem';
  throw new Error('BOOPY_MEMORY must be none or hmem.');
}

function speechOutputConfig(value: string | undefined): 'none' | 'mac-say' | 'qwen' {
  if (value === undefined || value === 'none') return 'none';
  if (value === 'mac-say') return 'mac-say';
  if (value === 'qwen') return 'qwen';
  throw new Error('BOOPY_SPEECH_OUTPUT must be none, mac-say or qwen.');
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value?.startsWith('/')) throw new Error(`${name} requires an absolute local path.`);
  return value;
}
function liveSceneConfig(env: NodeJS.ProcessEnv): Config['liveScene'] {
  if (env.BOOPY_LIVE_SCENE === undefined || env.BOOPY_LIVE_SCENE === 'none') return null;
  if (env.BOOPY_LIVE_SCENE !== 'local') throw new Error('BOOPY_LIVE_SCENE must be none or local.');
  return {
    python: required(env, 'BOOPY_SCENE_PYTHON'),
    detectorModel: required(env, 'BOOPY_SCENE_DETECTOR'),
    segmenterModel: required(env, 'BOOPY_SCENE_SEGMENTER'),
  };
}

function semanticMemoryConfig(env: NodeJS.ProcessEnv): Config['semanticMemory'] {
  const kind = env.BOOPY_SEMANTIC_MEMORY ?? 'none';
  if (kind === 'none') return null;
  if (kind !== 'nvidia-local')
    throw new Error('BOOPY_SEMANTIC_MEMORY must be none or nvidia-local.');
  if (env.BOOPY_MEMORY !== 'hmem')
    throw new Error('nvidia-local semantic memory requires BOOPY_MEMORY=hmem.');
  const device = env.BOOPY_NVIDIA_DEVICE;
  if (device !== 'cpu' && device !== 'mps')
    throw new Error('BOOPY_NVIDIA_DEVICE must be cpu or mps.');
  return {
    pythonPath: required(env, 'BOOPY_NVIDIA_PYTHON'),
    modelDirectory: required(env, 'BOOPY_NVIDIA_MODEL'),
    device,
  };
}
