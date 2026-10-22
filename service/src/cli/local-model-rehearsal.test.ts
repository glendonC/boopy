import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rehearsalSpeechOptions } from './local-model-rehearsal.ts';

test('synthetic rehearsal explicitly selects Qwen output without loading a worker', () => {
  assert.deepEqual(rehearsalSpeechOptions({}), { provider: 'mac-say' });
  assert.deepEqual(
    rehearsalSpeechOptions({
      BOOPY_SPEECH_OUTPUT: 'qwen',
      BOOPY_VOICE_PYTHON: '/synthetic/python',
      BOOPY_VOICE_MODEL: '/synthetic/model',
    }),
    { provider: 'qwen', python: '/synthetic/python', modelDirectory: '/synthetic/model' },
  );
  assert.throws(() => rehearsalSpeechOptions({ BOOPY_SPEECH_OUTPUT: 'qwen' }));
  assert.throws(() => rehearsalSpeechOptions({ BOOPY_SPEECH_OUTPUT: 'hosted' }));
});
