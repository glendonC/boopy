import assert from 'node:assert/strict';
import { test } from 'node:test';
import { demoReadiness } from './demo-readiness.ts';

function dependencies(tags: unknown = { models: [{ name: 'qwen3.6:35b-a3b-nvfp4' }] }) {
  const reads: string[] = [];
  return {
    reads,
    file: async () => true,
    voices: async () => 'Samantha en_US\nYuna ko_KR\n',
    fetch: (async (input, init) => {
      reads.push(String(input));
      assert.equal(init?.method, 'GET');
      assert.equal(init?.redirect, 'error');
      assert.ok(init?.signal instanceof AbortSignal);
      return String(input).endsWith('/api/tags')
        ? Response.json(tags)
        : new Response('', { status: 503 });
    }) as typeof fetch,
  };
}
test('only fixed loopback reads; missing service and wearer do not claim acceptance', async () => {
  const deps = dependencies();
  const result = await demoReadiness(deps);
  assert.equal(result.providerPrerequisitesReady, true);
  assert.deepEqual(deps.reads, [
    'http://127.0.0.1:11434/api/tags',
    'http://127.0.0.1:47900/v1/health',
  ]);
  assert.equal(result.capabilities.at(-1)?.status, 'unverified');
});
test('missing model, files or Korean voice fail readiness', async () => {
  assert.equal(
    (await demoReadiness(dependencies({ models: 'invalid' }))).providerPrerequisitesReady,
    false,
  );
  assert.equal(
    (await demoReadiness({ ...dependencies(), file: async () => false }))
      .providerPrerequisitesReady,
    false,
  );
  assert.equal(
    (await demoReadiness({ ...dependencies(), voices: async () => 'Samantha en_US' }))
      .providerPrerequisitesReady,
    false,
  );
});
test('failed reads are statuses without exception disclosure', async () => {
  const result = await demoReadiness({
    ...dependencies(),
    fetch: async () => {
      throw new Error('private');
    },
    voices: async () => {
      throw new Error('private');
    },
  });
  assert.equal(result.providerPrerequisitesReady, false);
  assert.ok(!JSON.stringify(result).includes('private'));
});

test('Qwen and local scene check explicit files independently of MacSay and runtime acceptance', async () => {
  const paths: string[] = [];
  const deps = dependencies();
  const result = await demoReadiness(
    {
      ...deps,
      file: async (path) => {
        paths.push(path);
        return true;
      },
      voices: async () => {
        throw new Error('must not query MacSay');
      },
      fetch: (async (input) =>
        String(input).endsWith('/api/tags')
          ? Response.json({ models: [{ name: 'qwen3.6:35b-a3b-nvfp4' }] })
          : Response.json({
              ok: true,
              service: 'boopy',
              liveScene: { provider: 'local' },
            })) as typeof fetch,
    },
    {
      BOOPY_SPEECH_OUTPUT: 'qwen',
      BOOPY_VOICE_PYTHON: '/synthetic/voice/python',
      BOOPY_VOICE_MODEL: '/synthetic/voice/model',
      BOOPY_LIVE_SCENE: 'local',
      BOOPY_SCENE_PYTHON: '/synthetic/scene/python',
      BOOPY_SCENE_DETECTOR: '/synthetic/detector',
      BOOPY_SCENE_SEGMENTER: '/synthetic/segmenter',
    },
  );
  assert.equal(result.providerPrerequisitesReady, true);
  assert.equal(result.liveProviderConfigured, true);
  assert.equal(result.voiceRuntimeReady, 'unverified');
  assert.equal(result.wearerAcceptance, 'unverified');
  assert.ok(paths.includes('/synthetic/voice/model/model.safetensors'));
  assert.ok(!paths.includes('/usr/bin/say'));
});

test('missing neural paths cannot be masked by MacSay prerequisites or healthy generic service', async () => {
  const result = await demoReadiness(dependencies(), {
    BOOPY_SPEECH_OUTPUT: 'qwen',
    BOOPY_LIVE_SCENE: 'local',
  });
  assert.equal(result.providerPrerequisitesReady, false);
  assert.equal(result.liveProviderConfigured, false);
  assert.equal(result.voiceRuntimeReady, 'unverified');
});

test('non-success tags and health bodies are cancelled without reading endless streams', async () => {
  let cancelled = 0;
  const result = await demoReadiness(
    {
      ...dependencies(),
      fetch: async () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled++;
            },
          }),
          { status: 503 },
        ),
    },
    {},
  );
  assert.equal(cancelled, 2);
  assert.equal(result.serviceHealthy, false);
  assert.equal(result.providerPrerequisitesReady, false);
});
