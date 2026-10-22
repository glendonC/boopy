/** Synthetic adversarial section 11 tests. No model, saved service, or fixed port is used. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { ActivityStore } from '../activity.ts';
import { ActivityCalls } from '../activity-call.ts';
import { ActivityRequestFile, ActivityView, sha256 } from '../activity-contract.ts';
import { OllamaActivityAssistant } from '../activity-ollama.ts';
import type { HandoffPreparation } from '../handoff-preparation.ts';
import { Journal, type Recorded } from '../journal.ts';
import { startRequest, testBoopy } from '../testing.ts';

const MODEL = 'qwen3.6:35b-a3b-nvfp4';
const LOCAL = {
  name: MODEL,
  digest: 'e92a3e94bbca90a85491dc34e9257bfee2318cedaa16360828c4d8edf14295b9',
  size: 23598465691,
  details: { format: 'safetensors' },
};
const SHOW = {
  details: { format: 'safetensors' },
  model_info: { 'general.architecture': 'qwen3_5_moe', 'general.parameter_count': 35951479808 },
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function answer(sourceId: string | null = null) {
  return {
    activity: {
      title: 'Synthetic scale',
      purpose: 'Compare two synthetic positions.',
      instruction: { text: 'Place the two markers.', language: 'en' },
      components: [
        {
          type: 'arrange',
          axis: { kind: 'scale', low: 'low', high: 'high' },
          tokens: [
            { key: 'a', label: { text: 'first', language: 'en' }, sourceId },
            { key: 'b', label: { text: 'second', language: 'en' }, sourceId: null },
          ],
        },
      ],
      hints: [],
    },
    fallbackText: 'Place the synthetic first and second markers.',
  };
}

function reply(next: ReturnType<typeof answer> | null = null) {
  return {
    reply: {
      summary: { text: 'Synthetic feedback.', language: 'en' },
      points: [{ about: 'arrange', text: 'Synthetic positions recorded.', language: 'en' }],
    },
    next,
  };
}

async function setup() {
  const test = testBoopy();
  const session = await test.boopy.start(startRequest('Synthetic audit call.'));
  const packageId = test.boopy.commit(session.id).committed?.packageId;
  assert.ok(packageId);
  const dependencies = {
    journal: test.journal,
    preparation: {
      forPackage: () =>
        ({
          sessionId: session.id,
          requestId: 'synthetic-audit-preparation',
          receiptId: 'synthetic-audit-receipt',
          sourceState: 'unchanged',
          receipt: { packetSha256: sha256('Synthetic audit packet.') },
        }) as ReturnType<HandoffPreparation['forPackage']>,
      readPacket: async () => 'Synthetic audit packet.',
    },
    packageForId: (id: string) => test.boopy.package(id),
    supersessions: () => test.boopy.supersessions,
  };
  const store = new ActivityStore(dependencies);
  const prompts: { system: string; user: string }[] = [];
  let output = JSON.stringify(answer());
  let wait: Promise<void> | null = null;
  const calls = new ActivityCalls({
    store,
    assistant: {
      provider: 'ollama',
      model: MODEL,
      ask: async (input, signal) => {
        prompts.push(input);
        if (wait)
          await Promise.race([
            wait,
            new Promise<never>((_, reject) => {
              signal.addEventListener('abort', () => reject(signal.reason), { once: true });
            }),
          ]);
        return { content: output, metrics: null };
      },
    },
  });
  return {
    ...test,
    packageId,
    dependencies,
    store,
    calls,
    prompts,
    setOutput: (value: unknown) => {
      output = JSON.stringify(value);
    },
    hold: () => {
      let release = () => {};
      wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
    ask: () => calls.askForPractice({ packageId, goal: 'Synthetic audit practice.' }),
    close: async () => {
      await calls.close(0);
      test.journal.close();
    },
  };
}

type Setup = Awaited<ReturnType<typeof setup>>;

async function called(s: Setup) {
  const done = await s.calls.finished((await s.ask()).callId);
  assert.equal(done.state, 'imported');
  assert.ok(done.activityId);
  s.store.arrange(done.activityId, { revision: 0, positions: { a: 0.2, b: 0.8 } });
  return done.activityId;
}

function replay(events: Recorded[]) {
  const journal = Journal.open(':memory:');
  for (const event of events) journal.append(event, event.id, event.at);
  return { journal, store: () => new ActivityStore({ journal }) };
}

function changed(events: Recorded[], type: string, mutate: (row: MutableRow) => void) {
  return events.map((event) => {
    const row = structuredClone(event) as unknown as MutableRow;
    if (row.type === type) mutate(row);
    return row as unknown as Recorded;
  });
}

type MutableRow = {
  type: string;
  actor: string;
  data: Record<string, unknown>;
};

test('audit calls: invalid activity output and foreign sources never import', async () => {
  const s = await setup();
  try {
    for (const value of [
      answer('ctx_other:itm_other'),
      { ...answer(), fallbackText: 'www.synthetic.invalid' },
      { ...answer(), activity: { ...answer().activity, title: 'hidden\u{202e}text' } },
      { ...answer(), activity: { ...answer().activity, components: [] } },
    ]) {
      s.setOutput(value);
      const done = await s.calls.finished((await s.ask()).callId);
      assert.equal(done.failure?.code, 'answer_invalid');
      assert.equal(done.activityId, null);
      assert.equal(s.store.list().length, 0);
      assert.doesNotMatch(JSON.stringify(done.issues), /www\.|\u{202e}/u);
    }
    assert.equal(s.prompts.length, 4, 'a failed output was retried');
  } finally {
    await s.close();
  }
});

test('audit calls: invalid next rejects the entire reply before any import event', async () => {
  const s = await setup();
  try {
    const id = await called(s);
    s.setOutput({ ...reply(), next: { ...answer(), fallbackText: 'https://synthetic.invalid' } });
    const submission = s.calls.submit(id, { revision: 1 }).submissions.at(-1);
    assert.ok(submission?.replyCall);
    const done = await s.calls.finished(submission.replyCall.callId);
    assert.equal(done.failure?.code, 'answer_invalid');
    assert.equal(s.store.view(id).submissions.at(-1)?.reply, null);
    assert.equal(
      s.journal.all().some((event) => event.type === 'activity.reply-imported'),
      false,
    );
  } finally {
    await s.close();
  }
});

for (const manualFirst of [true, false]) {
  test(`audit calls: identical manual and called bytes keep distinct provenance (${manualFirst})`, async () => {
    const s = await setup();
    try {
      const release = s.hold();
      const call = await s.ask();
      const user = s.prompts[0]?.user ?? '';
      const request = ActivityRequestFile.parse(JSON.parse(user.slice(user.indexOf('\n\n{') + 2)));
      const content = `${JSON.stringify({ type: 'boopy.activity', version: 1, binding: request.respondWith.binding, ...answer() }, null, 2)}\n`;
      const before = manualFirst ? s.store.importActivity(content) : null;
      release();
      const done = await s.calls.finished(call.callId);
      assert.ok(done.activityId);
      const manual = before ?? s.store.importActivity(content);
      assert.notEqual(manual.activityId, done.activityId);
      assert.equal(s.store.importActivity(content).activityId, manual.activityId);
      const manualView = s.store.view(manual.activityId);
      assert.equal(manualView.provenance.authorship, 'claimed-by-file');
      assert.equal('call' in manualView.provenance, false);
      assert.equal(s.store.view(done.activityId).provenance.authorship, 'called-by-boopy');
      const copied = replay(s.journal.all());
      try {
        assert.deepEqual(copied.store().view(manual.activityId), manualView);
      } finally {
        copied.journal.close();
      }
    } finally {
      await s.close();
    }
  });
}

test('audit calls: automatic busy reply preserves person action and never queues a retry', async () => {
  const s = await setup();
  try {
    const id = await called(s);
    const release = s.hold();
    const other = await s.ask();
    const submission = s.calls.submit(id, { revision: 1 }).submissions.at(-1);
    assert.equal(submission?.replyCall?.failure?.code, 'assistant_busy');
    const events = s.journal.all();
    assert.equal(events.findLast((event) => event.type === 'activity.submitted')?.actor, 'person');
    assert.equal(events.findLast((event) => event.type === 'activity.call-asked')?.actor, 'system');
    const count = s.prompts.length;
    release();
    await s.calls.finished(other.callId);
    await sleep(10);
    assert.equal(s.prompts.length, count);
    assert.equal(s.store.view(id).submissions.at(-1)?.replyCall?.state, 'failed');
  } finally {
    await s.close();
  }
});

test('audit calls: a crash after activity import interrupts the call without another ask', async () => {
  const s = await setup();
  try {
    const done = await s.calls.finished((await s.ask()).callId);
    assert.ok(done.activityId);
    const events = s.journal.all();
    const split = events.findIndex((event) => event.type === 'activity.imported');
    const copy = replay(events.slice(0, split + 1));
    try {
      const store = copy.store();
      assert.equal(store.call(done.callId).state, 'interrupted');
      assert.equal(store.view(done.activityId).provenance.authorship, 'called-by-boopy');
      const recorded = copy.journal.all().length;
      copy.store();
      assert.equal(copy.journal.all().length, recorded, 'restart repeated recovery');
      assert.equal(s.prompts.length, 1);
    } finally {
      copy.journal.close();
    }
  } finally {
    await s.close();
  }
});

test('audit calls: a crash between reply and next import never exposes an unavailable next activity', async () => {
  const s = await setup();
  try {
    const id = await called(s);
    s.setOutput(reply(answer()));
    const submission = s.calls.submit(id, { revision: 1 }).submissions.at(-1);
    assert.ok(submission?.replyCall);
    await s.calls.finished(submission.replyCall.callId);
    const events = s.journal.all();
    const split = events.findIndex((event) => event.type === 'activity.reply-imported');
    const copy = replay(events.slice(0, split + 1));
    try {
      const store = copy.store();
      assert.equal(store.call(submission.replyCall.callId).state, 'interrupted');
      const nextId = store.view(id).submissions.at(-1)?.reply?.nextActivityId;
      if (nextId) assert.doesNotThrow(() => store.view(nextId), 'reply exposes a dangling next ID');
    } finally {
      copy.journal.close();
    }
  } finally {
    await s.close();
  }
});

const malformed: [string, string, (row: MutableRow) => void][] = [
  [
    'practice actor',
    'activity.call-asked',
    (row) => {
      row.actor = 'system';
    },
  ],
  [
    'provider',
    'activity.call-asked',
    (row) => {
      row.data.provider = 'cloud';
    },
  ],
  [
    'call identifier',
    'activity.call-asked',
    (row) => {
      row.data.callId = 'not-a-call';
    },
  ],
  [
    'finish outcome',
    'activity.call-finished',
    (row) => {
      row.data.outcome = 'confirmed';
    },
  ],
  [
    'failure text',
    'activity.call-finished',
    (row) => {
      row.data.failure = { code: 'assistant_error', message: 'https://synthetic.invalid/\u{202e}' };
    },
  ],
  [
    'failure code',
    'activity.call-finished',
    (row) => {
      row.data.failure = { code: 'confirmed', message: 'Synthetic.' };
    },
  ],
  [
    'issues without invalid answer',
    'activity.call-finished',
    (row) => {
      row.data.issues = ['synthetic: https://synthetic.invalid'];
    },
  ],
];

for (const [name, type, mutate] of malformed) {
  test(`audit calls: replay rejects malformed ${name}`, async () => {
    const s = await setup();
    try {
      s.setOutput({});
      await s.calls.finished((await s.ask()).callId);
      const rows = changed(s.journal.all(), type, mutate);
      // The invalid identifier is changed in both events to test its shape, not a missing ID.
      if (name === 'call identifier')
        for (const row of rows)
          if (row.type === 'activity.call-finished') row.data.callId = 'not-a-call';
      const copy = replay(rows);
      try {
        assert.throws(copy.store, /does not fit|invalid|Invalid/, 'malformed journal was trusted');
      } finally {
        copy.journal.close();
      }
    } finally {
      await s.close();
    }
  });
}

for (const [name, model] of [
  ['empty', ''],
  ['Grok', 'grok-local'],
  ['overlong', 'q'.repeat(46)],
  ['URL and bidi', 'https://synthetic.invalid/\u{202e}'],
]) {
  test(`audit calls: replay rejects invalid known model provenance (${name})`, async () => {
    const s = await setup();
    try {
      await s.calls.finished((await s.ask()).callId);
      const copy = replay(
        changed(
          changed(s.journal.all(), 'activity.call-asked', (row) => {
            row.data.model = model;
          }),
          'activity.imported',
          (row) => {
            const call = row.data.call;
            assert.ok(call && typeof call === 'object');
            (call as Record<string, unknown>).model = model;
          },
        ),
      );
      try {
        assert.throws(copy.store, /does not fit|invalid|Invalid/, 'invalid model was trusted');
      } finally {
        copy.journal.close();
      }
    } finally {
      await s.close();
    }
  });
}

for (const kind of ['activity', 'reply', 'reply next']) {
  test(`audit calls: replay rejects ${kind} timing inconsistent with successful call provenance`, async () => {
    const s = await setup();
    try {
      const id = await called(s);
      if (kind !== 'activity') {
        s.setOutput(reply(answer()));
        const submission = s.calls.submit(id, { revision: 1 }).submissions.at(-1);
        assert.ok(submission?.replyCall);
        await s.calls.finished(submission.replyCall.callId);
      }
      const target = s.journal.all().findLast((event) => event.type === 'activity.call-finished');
      assert.ok(target);
      const rows = s.journal.all().map((event) => {
        const row = structuredClone(event);
        if (
          kind === 'reply next' &&
          row.type === 'activity.imported' &&
          row.data.parent !== null &&
          row.data.call
        )
          row.data.call.durationMs += 1000;
        else if (
          kind !== 'reply next' &&
          row.id === target.id &&
          row.type === 'activity.call-finished'
        )
          row.data.durationMs = (row.data.durationMs ?? 0) + 1000;
        return row;
      });
      const copy = replay(rows);
      try {
        assert.throws(copy.store, /does not fit|invalid|Invalid/, 'conflicting timing was trusted');
      } finally {
        copy.journal.close();
      }
    } finally {
      await s.close();
    }
  });
}

test('audit calls: valid failed and busy calls retain their views on replay', async () => {
  const s = await setup();
  try {
    for (const value of [{}, 'Synthetic unreadable answer.']) {
      s.setOutput(value);
      const done = await s.calls.finished((await s.ask()).callId);
      assert.equal(done.state, 'failed');
      const copy = replay(s.journal.all());
      try {
        assert.deepEqual(copy.store().call(done.callId), done);
      } finally {
        copy.journal.close();
      }
    }
    s.setOutput(answer());
    const id = await called(s);
    const release = s.hold();
    const running = await s.ask();
    const busy = s.calls.submit(id, { revision: 1 }).submissions.at(-1)?.replyCall;
    assert.equal(busy?.failure?.code, 'assistant_busy');
    release();
    await s.calls.finished(running.callId);
    const copy = replay(s.journal.all());
    try {
      assert.deepEqual(copy.store().view(id), s.store.view(id));
      assert.deepEqual(copy.store().calls(), s.store.calls());
    } finally {
      copy.journal.close();
    }
  } finally {
    await s.close();
  }
});

test('audit calls: replay rejects issues whose parsed normalization differs from stored text', async () => {
  const s = await setup();
  try {
    s.setOutput({});
    await s.calls.finished((await s.ask()).callId);
    for (const issue of [' synthetic: Invalid answer.', 'synthetic: Cafe\u{0301}.']) {
      const copy = replay(
        changed(s.journal.all(), 'activity.call-finished', (row) => {
          row.data.issues = [issue];
        }),
      );
      try {
        assert.throws(copy.store, /does not fit|invalid|Invalid/);
      } finally {
        copy.journal.close();
      }
    }
  } finally {
    await s.close();
  }
});

test('audit calls: the generated headset fixture retains separate call provenance', () => {
  const fixture = ActivityView.parse(
    JSON.parse(
      readFileSync(
        new URL('../../fixtures/activity/called-with-reply.json', import.meta.url),
        'utf8',
      ),
    ),
  );
  assert.equal(fixture.provenance.authorship, 'called-by-boopy');
  assert.equal(fixture.provenance.claimedAuthor, null);
  assert.equal(fixture.provenance.call?.provider, 'ollama');
  assert.equal(fixture.submissions[0]?.replyCall?.state, 'imported');
  assert.equal(fixture.submissions[0]?.reply?.claimedAuthor, null);
  assert.equal(fixture.submissions[0]?.reply?.call?.model, MODEL);
});

type Handler = (path: string, response: ServerResponse) => void;
async function server(handler: Handler) {
  const requests: { path: string; body: string }[] = [];
  const http = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      requests.push({ path: request.url ?? '', body: Buffer.concat(chunks).toString() });
      handler(request.url ?? '', response);
    });
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(http.address() as AddressInfo).port}`,
    requests,
    close: async () => {
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

function json(response: ServerResponse, value: unknown) {
  response.end(JSON.stringify(value));
}

test('audit calls: missing and malformed metadata send zero prompt bytes', async () => {
  let tags: unknown = {};
  let show: unknown = {};
  const fake = await server((path, response) => json(response, path === '/api/tags' ? tags : show));
  try {
    const assistant = new OllamaActivityAssistant({ url: fake.url });
    for (const value of [
      null,
      [],
      { models: [null] },
      { models: [LOCAL, null] },
      { models: [{ ...LOCAL, remote_host: 'https://synthetic.invalid' }] },
    ]) {
      tags = value;
      show = {};
      await assert.rejects(
        assistant.ask(
          { system: 'Synthetic.', user: 'Synthetic packet.' },
          AbortSignal.timeout(1000),
        ),
      );
    }
    tags = { models: [LOCAL] };
    for (const value of [null, [], {}, { ...SHOW, cloud: true }]) {
      show = value;
      await assert.rejects(
        assistant.ask(
          { system: 'Synthetic.', user: 'Synthetic packet.' },
          AbortSignal.timeout(1000),
        ),
      );
    }
    assert.equal(
      fake.requests.some((request) => request.path === '/api/chat'),
      false,
    );
    assert.equal(
      fake.requests.some((request) => request.body.includes('Synthetic packet.')),
      false,
    );
  } finally {
    await fake.close();
  }
});

test('audit calls: redirects at every phase never forward metadata or prompt', async () => {
  const target = await server((_, response) => json(response, {}));
  let redirected = '/api/tags';
  const fake = await server((path, response) => {
    if (path === redirected) {
      response.writeHead(307, { location: target.url });
      response.end();
    } else json(response, path === '/api/tags' ? { models: [LOCAL] } : SHOW);
  });
  try {
    const assistant = new OllamaActivityAssistant({ url: fake.url });
    for (const path of ['/api/tags', '/api/show', '/api/chat']) {
      redirected = path;
      await assert.rejects(
        assistant.ask(
          { system: 'Synthetic.', user: 'Synthetic packet.' },
          AbortSignal.timeout(1000),
        ),
      );
    }
    assert.equal(target.requests.length, 0);
  } finally {
    await fake.close();
    await target.close();
  }
});

test('audit calls: metadata body reads share the total timeout and cancellation budget', async () => {
  const fake = await server((path, response) => {
    if (path === '/api/tags') json(response, { models: [LOCAL] });
    else response.write('{"details":');
  });
  try {
    const assistant = new OllamaActivityAssistant({ url: fake.url });
    for (const stop of [false, true]) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), stop ? 40 : 80);
      const start = performance.now();
      try {
        await assert.rejects(
          assistant.ask({ system: 'Synthetic.', user: 'Synthetic packet.' }, controller.signal),
        );
        assert.ok(performance.now() - start < 1000);
      } finally {
        clearTimeout(timer);
      }
    }
    assert.equal(
      fake.requests.some((request) => request.path === '/api/chat'),
      false,
    );
  } finally {
    await fake.close();
  }
});
