import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { it } from 'node:test';
import { Boopy } from './boopy.ts';
import { connectorApp } from './http/connector.ts';
import { headsetApp } from './http/headset.ts';
import { FixtureInterpreter } from './interpret/fixture.ts';
import type { SpeechOutput } from './speech-output.ts';
import { startRequest, testBoopy } from './testing.ts';

const attention = {
  scope: 'scene' as const,
  evidence: 'none' as const,
  source: 'past-recollection' as const,
  ambiguousTarget: false,
  ocrRequested: false,
  segmentationRequested: false,
  maxAgeMs: 15000,
};
async function reply(boopy: Boopy) {
  const view = await boopy.start({
    cues: {},
    speech: { text: 'Synthetic trip felt cold.' },
    attention,
  });
  assert.ok(view.dialogue);
  return { view, input: { utteranceId: view.dialogue.utteranceId, responseAt: view.dialogue.at } };
}
function result() {
  return {
    wav: Buffer.from('synthetic-test-audio'),
    voice: 'synthetic-voice',
    language: 'en',
    latencyMs: 1,
  };
}
function deferred() {
  let finish: (value: ReturnType<typeof result>) => void = () => {
    throw new Error('not started');
  };
  let begun: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    begun = resolve;
  });
  const output: SpeechOutput = {
    synthesize: async () => {
      begun();
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  };
  return { output, started, finish: () => finish(result()) };
}

it('voice is unavailable by default without blocking capture or commit', async () => {
  const { boopy, journal } = testBoopy();
  const app = headsetApp(boopy, { logger: false });
  try {
    const { view, input } = await reply(boopy);
    assert.equal(view.speechOutputAvailable, false);
    const response = await app.inject({
      method: 'POST',
      url: `/v1/sessions/${view.id}/speech`,
      payload: input,
    });
    assert.equal(response.statusCode, 503);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.ok(boopy.commit(view.id).committed);
    assert.equal(journal.all().filter((event) => event.type.startsWith('speech.')).length, 0);
  } finally {
    await app.close();
    journal.close();
  }
});

it('headset route selects exact journaled English reply, rejects caller text, excludes connector and journals metadata only', async () => {
  const calls: { text: string; language: string }[] = [];
  const { boopy, journal, deps } = testBoopy({
    speechOutput: {
      async synthesize(text, language) {
        calls.push({ text, language });
        return result();
      },
    },
  });
  const app = headsetApp(boopy, { logger: false });
  const connector = connectorApp(boopy, {
    token: 'synthetic',
    baseUrl: 'http://127.0.0.1',
    logger: false,
  });
  try {
    const { view, input } = await reply(boopy);
    const url = `/v1/sessions/${view.id}/speech`;
    for (const payload of [
      { ...input, text: 'caller arbitrary text' },
      { utteranceId: input.utteranceId },
      { ...input, responseAt: 'invalid' },
    ])
      assert.equal((await app.inject({ method: 'POST', url, payload })).statusCode, 400);
    assert.equal(calls.length, 0);
    const response = await app.inject({ method: 'POST', url, payload: input });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.deepEqual(calls, [{ text: view.dialogue?.text, language: 'en' }]);
    assert.equal(response.json().speaker, 'boopy');
    assert.equal(response.json().wav, result().wav.toString('base64'));
    assert.equal(
      (
        await connector.inject({
          method: 'POST',
          url,
          headers: { authorization: 'Bearer synthetic' },
          payload: input,
        })
      ).statusCode,
      404,
    );
    const events = journal.all().filter((event) => event.type.startsWith('speech.'));
    assert.equal(events.length, 2);
    assert.equal(events[0]?.type, 'speech.requested');
    assert.equal(events[1]?.type, 'speech.finished');
    for (const event of events) {
      assert.ok(!('text' in event.data));
      assert.ok(!('wav' in event.data));
      assert.ok(!JSON.stringify(event).includes(result().wav.toString('base64')));
    }
    assert.equal(new Boopy(deps).view(view.id).dialogue?.text, view.dialogue?.text);
  } finally {
    await app.close();
    await connector.close();
    journal.close();
  }
});

it('bounds synthesis globally, permits capture/commit, and suppresses stale audio after mutation', async () => {
  const deferredOutput = deferred();
  const { boopy, journal } = testBoopy({ speechOutput: deferredOutput.output });
  try {
    const first = await reply(boopy),
      second = await reply(boopy);
    const pending = boopy.speak(first.view.id, first.input);
    await deferredOutput.started;
    await assert.rejects(boopy.speak(second.view.id, second.input), /busy/);
    const captured = await boopy.start(startRequest('Describe this synthetic trip.'));
    assert.ok(captured.items.length > 0);
    assert.ok(boopy.commit(first.view.id).committed);
    deferredOutput.finish();
    await assert.rejects(pending, /no longer current/);
    const finished = journal.all().filter((event) => event.type === 'speech.finished');
    assert.equal(finished.at(-1)?.data.outcome, 'stale');
    await assert.rejects(boopy.speak(first.view.id, first.input), /no longer current/);
  } finally {
    journal.close();
  }
});

it('suppresses an otherwise successful output after cancellation and releases the global slot', async () => {
  const deferredOutput = deferred();
  const { boopy, journal } = testBoopy({ speechOutput: deferredOutput.output });
  try {
    const { view, input } = await reply(boopy);
    const abort = new AbortController();
    const pending = boopy.speak(view.id, input, abort.signal);
    await deferredOutput.started;
    abort.abort();
    deferredOutput.finish();
    await assert.rejects(pending, /stopped/);
    assert.equal(
      journal
        .all()
        .filter((event) => event.type === 'speech.finished')
        .at(-1)?.data.outcome,
      'cancelled',
    );
    const next = boopy.speak(view.id, input);
    deferredOutput.finish();
    assert.equal((await next).speaker, 'boopy');
  } finally {
    journal.close();
  }
});

it('sanitizes output failure and journals failure without losing captions', async () => {
  const { boopy, journal } = testBoopy({
    speechOutput: {
      async synthesize() {
        throw new Error('synthetic-secret-error');
      },
    },
  });
  try {
    const { view, input } = await reply(boopy);
    await assert.rejects(boopy.speak(view.id, input), {
      message: 'Boopy voice is unavailable. The response remains in captions.',
    });
    assert.equal(boopy.view(view.id).dialogue?.text, view.dialogue?.text);
    assert.equal(
      journal
        .all()
        .filter((event) => event.type === 'speech.finished')
        .at(-1)?.data.outcome,
      'failed',
    );
    assert.ok(!JSON.stringify(journal.all()).includes('synthetic-secret-error'));
  } finally {
    journal.close();
  }
});

it('aborts synthesis when an actual loopback headset HTTP client disconnects', async () => {
  let began: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  let cancelled: () => void = () => {};
  const stopped = new Promise<void>((resolve) => {
    cancelled = resolve;
  });
  const output: SpeechOutput = {
    synthesize: async (_text, _language, signal) => {
      assert.ok(signal);
      began();
      return new Promise((_, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            cancelled();
            reject(new Error('cancelled'));
          },
          { once: true },
        );
      });
    },
  };
  const { boopy, journal } = testBoopy({ speechOutput: output });
  const app = headsetApp(boopy, { logger: false });
  try {
    const { view, input } = await reply(boopy);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const controller = new AbortController();
    const pending = fetch(
      `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/v1/sessions/${view.id}/speech`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
        signal: controller.signal,
      },
    );
    await started;
    controller.abort();
    await assert.rejects(pending);
    await Promise.race([
      stopped,
      new Promise((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error('disconnect did not cancel synthesis')),
          1000,
        );
        timer.unref();
      }),
    ]);
    assert.equal(boopy.view(view.id).dialogue?.text, view.dialogue?.text);
  } finally {
    await app.close();
    journal.close();
  }
});

for (const [requestText, responseText, expectedLanguage] of [
  ['What is this?', '기록된 그림으로 보여요.', 'ko'],
  ['이것은 무엇인가요?', 'This recorded object may be a painting.', 'en'],
] as const) {
  it(`selects ${expectedLanguage} from the actual response script independently of input language`, async () => {
    const fixture = new FixtureInterpreter();
    const calls: { text: string; language: string }[] = [];
    const { boopy, journal } = testBoopy({
      interpreter: {
        provider: 'fixture',
        model: 'script-test',
        async interpret(input) {
          const output = await fixture.interpret(input);
          output.output.response = responseText;
          return output;
        },
      },
      speechOutput: {
        async synthesize(text, language) {
          calls.push({ text, language });
          return { ...result(), language };
        },
      },
    });
    try {
      const request = startRequest(requestText);
      const view = await boopy.start({
        ...request,
        frame: { ...request.frame, source: 'current-surroundings', timestampTrusted: false },
        attention: { ...attention, evidence: 'visual', source: 'current-surroundings' },
      });
      assert.ok(view.dialogue);
      assert.equal(view.dialogue.text, responseText);
      const audio = await boopy.speak(view.id, {
        utteranceId: view.dialogue.utteranceId,
        responseAt: view.dialogue.at,
      });
      assert.deepEqual(calls, [{ text: responseText, language: expectedLanguage }]);
      assert.equal(audio.language, expectedLanguage);
      assert.equal(
        view.items.find((item) => item.label === 'Suggested answer')?.status,
        'proposed',
      );
    } finally {
      journal.close();
    }
  });
}

it('spoken save synthesizes the same plain local receipt shown by the headset', async () => {
  const spoken: string[] = [];
  const { boopy, journal } = testBoopy({
    speechOutput: {
      async synthesize(text) {
        spoken.push(text);
        return result();
      },
    },
  });
  try {
    const { view } = await reply(boopy);
    const saved = await boopy.utter(view.id, { speech: { text: 'Save it' }, attention });
    const receipt = 'Ready on your Mac. Not sent.';
    assert.equal(saved.state, 'committed');
    assert.equal(saved.notice, receipt);
    assert.equal(saved.dialogue?.text, receipt);
    assert.ok(saved.dialogue);
    await boopy.speak(saved.id, {
      utteranceId: saved.dialogue.utteranceId,
      responseAt: saved.dialogue.at,
    });
    assert.deepEqual(spoken, [receipt]);
    assert.ok(saved.committed);
  } finally {
    journal.close();
  }
});
