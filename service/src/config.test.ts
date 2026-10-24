import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { loadConfig } from './config.ts';

describe('local activity assistant configuration', () => {
  const env = { BOOPY_INTERPRETER: 'fixture', BOOPY_SEGMENTER: 'none' };
  it('defaults on with the verified model and can be disabled', () => {
    assert.deepEqual(loadConfig(env).activityAssistant, {
      kind: 'ollama',
      url: 'http://127.0.0.1:11434',
      model: 'qwen3.6:35b-a3b-nvfp4',
    });
    assert.equal(loadConfig({ ...env, BOOPY_ACTIVITY_ASSISTANT: 'none' }).activityAssistant, null);
  });
  it('refuses unsupported providers, remote URLs and unverified model names without echoing secrets', () => {
    for (const extra of [
      { BOOPY_ACTIVITY_ASSISTANT: 'cloud' },
      { BOOPY_OLLAMA_URL: 'http://synthetic-user:synthetic-secret@127.0.0.1:11434' },
      { BOOPY_OLLAMA_URL: 'http://192.0.2.1:11434' },
      { BOOPY_ACTIVITY_MODEL: 'synthetic:cloud' },
    ])
      assert.throws(
        () => loadConfig({ ...env, ...extra }),
        (error: unknown) => error instanceof Error && !error.message.includes('synthetic-secret'),
      );
  });
});

describe('Meta Model API key configuration', () => {
  let dataDir: string;
  let path: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'boopy-config-test-'));
    path = join(dataDir, 'model-api-key');
    env = { BOOPY_DATA_DIR: dataDir, BOOPY_INTERPRETER: 'muse-spark' };
  });
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

  it('uses the environment key without reading an insecure key file', () => {
    writeFileSync(path, 'synthetic-file-key', { mode: 0o644 });
    assert.deepEqual(loadConfig({ ...env, MODEL_API_KEY: 'synthetic-env-key' }).interpreter, {
      kind: 'muse-spark',
      apiKey: 'synthetic-env-key',
      model: 'muse-spark-1.3',
    });
  });

  it('reads the private key file when the environment key is unset and trims whitespace', () => {
    writeFileSync(path, 'synthetic-file-key\n', { mode: 0o600 });
    assert.deepEqual(loadConfig(env).interpreter, {
      kind: 'muse-spark',
      apiKey: 'synthetic-file-key',
      model: 'muse-spark-1.3',
    });
  });

  it('reports a missing key file without needing any real credentials', () => {
    assert.throws(() => loadConfig(env), /needs MODEL_API_KEY or a readable .*model-api-key/);
  });

  it('refuses an empty key file', () => {
    writeFileSync(path, '\n \n', { mode: 0o600 });
    assert.throws(() => loadConfig(env), /model-api-key is empty/);
  });

  it('refuses an explicitly empty environment key instead of falling back to the file', () => {
    writeFileSync(path, 'synthetic-file-key', { mode: 0o600 });
    for (const key of ['', ' \n']) {
      assert.throws(() => loadConfig({ ...env, MODEL_API_KEY: key }), /MODEL_API_KEY is empty/);
    }
  });

  it('requires exactly mode 0600 and never includes the key in an error', () => {
    const key = 'synthetic-key-that-must-not-appear-in-errors';
    writeFileSync(path, key, { mode: 0o600 });
    for (const mode of [0o644, 0o640, 0o400]) {
      chmodSync(path, mode);
      assert.throws(
        () => loadConfig(env),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /must be a regular file with mode 0600/);
          assert.ok(!error.message.includes(key));
          return true;
        },
      );
    }
  });

  it('does not require a key for the local or fixture interpreter', () => {
    for (const kind of ['ollama', 'fixture']) {
      assert.equal(loadConfig({ ...env, BOOPY_INTERPRETER: kind }).interpreter.kind, kind);
    }
    assert.equal(loadConfig({ BOOPY_DATA_DIR: dataDir }).interpreter.kind, 'ollama');
  });

  it('keeps segmentation off by default and reads a key only for explicit hosted opt-in', () => {
    const local = { ...env, BOOPY_INTERPRETER: 'ollama' };
    assert.equal(loadConfig(local).segmenter, null);
    assert.equal(loadConfig({ ...local, BOOPY_SEGMENTER: 'none' }).segmenter, null);
    assert.throws(() => loadConfig({ ...local, BOOPY_SEGMENTER: 'sam' }), /needs MODEL_API_KEY/);
    writeFileSync(path, 'synthetic-file-key\n', { mode: 0o600 });
    assert.deepEqual(loadConfig({ ...local, BOOPY_SEGMENTER: 'sam' }).segmenter, {
      kind: 'sam',
      apiKey: 'synthetic-file-key',
    });
    assert.throws(
      () => loadConfig({ ...local, BOOPY_SEGMENTER: 'sam-contributor' }),
      /BOOPY_SEGMENTER must be none or sam/,
    );
  });
});

it('keeps the connection reply routes off unless BOOPY_CONNECTION_REPLIES is 1', () => {
  const env = { BOOPY_INTERPRETER: 'fixture', BOOPY_LOG: '0' };
  assert.equal(loadConfig(env).connectionReplies, false);
  assert.equal(loadConfig({ ...env, BOOPY_CONNECTION_REPLIES: 'true' }).connectionReplies, false);
  assert.equal(loadConfig({ ...env, BOOPY_CONNECTION_REPLIES: '1' }).connectionReplies, true);
});

it('keeps local memory opt-in and rejects unknown backends without provider fallback', () => {
  const env = { BOOPY_INTERPRETER: 'fixture', BOOPY_LOG: '0' };
  assert.equal(loadConfig(env).memory, 'none');
  assert.equal(loadConfig({ ...env, BOOPY_MEMORY: 'none' }).memory, 'none');
  assert.equal(loadConfig({ ...env, BOOPY_MEMORY: 'hmem' }).memory, 'hmem');
  assert.throws(() => loadConfig({ ...env, BOOPY_MEMORY: 'hosted' }), /BOOPY_MEMORY must be/);
});

it('keeps local speech output opt-in without hosted fallback', () => {
  const env = { BOOPY_INTERPRETER: 'fixture', BOOPY_LOG: '0' };
  assert.equal(loadConfig(env).speechOutput, 'none');
  assert.equal(loadConfig({ ...env, BOOPY_SPEECH_OUTPUT: 'mac-say' }).speechOutput, 'mac-say');
  assert.throws(
    () => loadConfig({ ...env, BOOPY_SPEECH_OUTPUT: 'hosted' }),
    /BOOPY_SPEECH_OUTPUT must be/,
  );
});

it('requires explicit absolute local Qwen paths and keeps neural voice disabled for other modes', () => {
  const env = { BOOPY_INTERPRETER: 'fixture', BOOPY_LOG: '0' };
  assert.equal(loadConfig(env).neuralVoice, null);
  assert.equal(loadConfig({ ...env, BOOPY_SPEECH_OUTPUT: 'mac-say' }).neuralVoice, null);
  const enabled = {
    ...env,
    BOOPY_SPEECH_OUTPUT: 'qwen',
    BOOPY_VOICE_PYTHON: '/synthetic/venv/bin/python',
    BOOPY_VOICE_MODEL: '/synthetic/model',
  };
  assert.equal(loadConfig(enabled).speechOutput, 'qwen');
  assert.deepEqual(loadConfig(enabled).neuralVoice, {
    python: enabled.BOOPY_VOICE_PYTHON,
    modelDirectory: enabled.BOOPY_VOICE_MODEL,
  });
  for (const name of ['BOOPY_VOICE_PYTHON', 'BOOPY_VOICE_MODEL']) {
    for (const value of [undefined, '', 'relative/path'])
      assert.throws(
        () => loadConfig({ ...enabled, [name]: value }),
        new RegExp(`${name} requires an absolute local path`),
      );
  }
});

it('requires explicit local NVIDIA paths/device and enabled H-MEM, with no backend fallback', () => {
  const env = { BOOPY_INTERPRETER: 'fixture' };
  assert.equal(loadConfig(env).semanticMemory, null);
  const configured = {
    ...env,
    BOOPY_MEMORY: 'hmem',
    BOOPY_SEMANTIC_MEMORY: 'nvidia-local',
    BOOPY_NVIDIA_PYTHON: '/isolated/python',
    BOOPY_NVIDIA_MODEL: '/isolated/model',
    BOOPY_NVIDIA_DEVICE: 'mps',
  };
  assert.deepEqual(loadConfig(configured).semanticMemory, {
    pythonPath: '/isolated/python',
    modelDirectory: '/isolated/model',
    device: 'mps',
  });
  for (const patch of [
    { BOOPY_MEMORY: 'none' },
    { BOOPY_SEMANTIC_MEMORY: 'cloud' },
    { BOOPY_NVIDIA_PYTHON: 'python' },
    { BOOPY_NVIDIA_MODEL: '' },
    { BOOPY_NVIDIA_DEVICE: 'auto' },
  ])
    assert.throws(() => loadConfig({ ...configured, ...patch }));
  assert.equal(
    loadConfig({ ...configured, BOOPY_NVIDIA_DEVICE: 'cpu' }).semanticMemory?.device,
    'cpu',
  );
});
it('requires an absolute explicitly configured Zetaris credential path', () => {
  const env = { BOOPY_INTERPRETER: 'fixture' };
  assert.throws(
    () => loadConfig({ ...env, BOOPY_ZETARIS_REFERENCE_CREDENTIAL_FILE: 'secret.json' }),
    /absolute local path/,
  );
  assert.throws(
    () => loadConfig({ ...env, BOOPY_ZETARIS_REFERENCE_CREDENTIAL_FILE: '' }),
    /absolute local path/,
  );
  assert.equal(
    loadConfig({ ...env, BOOPY_ZETARIS_REFERENCE_CREDENTIAL_FILE: '/private/synthetic-credential' })
      .referenceCredentialFile,
    '/private/synthetic-credential',
  );
});
