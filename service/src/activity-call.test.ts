import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import { ActivityStore } from './activity.ts';
import { ActivityCalls } from './activity-call.ts';
import {
  ActivityCallView,
  ActivityRequestFile,
  ActivitySubmissionFile,
  ActivitySummary,
  ActivityView,
  allowedSources,
  sha256,
} from './activity-contract.ts';
import { OllamaActivityAssistant } from './activity-ollama.ts';
import { BoopyError } from './boopy.ts';
import type { HandoffPreparation } from './handoff-preparation.ts';
import { Journal } from './journal.ts';
import { startRequest, testBoopy } from './testing.ts';

// Local model calls against a fake Ollama on a loopback port. Nothing here reaches a model.
// Every text is synthetic.

const MODEL = 'qwen3.6:35b-a3b-nvfp4';
const LOCAL_MODEL = {
  name: MODEL,
  digest: 'e92a3e94bbca90a85491dc34e9257bfee2318cedaa16360828c4d8edf14295b9',
  size: 23598465691,
  details: { format: 'safetensors' },
};
const LOCAL_SHOW = {
  details: { format: 'safetensors' },
  model_info: { 'general.architecture': 'qwen3_5_moe', 'general.parameter_count': 35951479808 },
};
const PACKET =
  'Synthetic prepared packet: a toy camel stands left of a toy tent in a fictional camp.';
const GOAL = 'Practice saying where things are in Korean.';
const PRACTICE = "Boopy couldn't make practice from this: ";
const REPLY = "Boopy couldn't make a reply from this: ";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check: () => boolean, timeout = 2000) {
  const deadline = performance.now() + timeout;
  while (!check()) {
    if (performance.now() > deadline) throw new Error('Timed out waiting.');
    await sleep(5);
  }
}

type Chat = {
  model: string;
  messages: { role: string; content: string }[];
  stream: boolean;
  think: boolean;
  keep_alive: string;
  options: Record<string, number>;
  format?: unknown;
};
type Responder = (response: ServerResponse) => void;

/** Records each chat request and answers it with the next queued responder. */
class FakeOllama {
  metadataHangs = false;
  models: unknown[] = [LOCAL_MODEL];
  show: unknown = LOCAL_SHOW;
  readonly requests: { method: string; url: string; body: Chat }[] = [];
  /** Requests whose caller went away before the answer was complete. */
  aborted = 0;
  readonly #answers: Responder[] = [];
  readonly #server = createServer((request, response) => this.#handle(request, response));

  static async start(): Promise<FakeOllama> {
    const fake = new FakeOllama();
    await new Promise<void>((resolve) => fake.#server.listen(0, '127.0.0.1', resolve));
    return fake;
  }

  get url(): string {
    return `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`;
  }

  answer(...responders: Responder[]): void {
    this.#answers.push(...responders);
  }

  async close(): Promise<void> {
    this.#server.closeAllConnections();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  #handle(request: IncomingMessage, response: ServerResponse) {
    if (this.metadataHangs && request.url === '/api/tags') {
      response.on('close', () => {
        if (!response.writableFinished) this.aborted += 1;
      });
      return;
    }
    if (request.url === '/api/tags') {
      response.end(JSON.stringify({ models: this.models }));
      return;
    }
    if (request.url === '/api/show') {
      request.resume();
      response.end(JSON.stringify(this.show));
      return;
    }
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      this.requests.push({
        method: request.method ?? '',
        url: request.url ?? '',
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      });
      response.on('close', () => {
        if (!response.writableFinished) this.aborted += 1;
      });
      (this.#answers.shift() ?? status(500, '{"error":"no synthetic answer queued"}'))(response);
    });
  }
}

const chat =
  (content: string, fields: Record<string, unknown> = {}): Responder =>
  (response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        model: MODEL,
        message: { role: 'assistant', content },
        done: true,
        done_reason: 'stop',
        total_duration: 1_500_000_000,
        load_duration: 16_000_000,
        prompt_eval_count: 3386,
        prompt_eval_duration: 780_000_000,
        eval_count: 712,
        eval_duration: 615_000_000,
        ...fields,
      }),
    );
  };
const answerWith = (value: unknown) => chat(JSON.stringify(value));
const status =
  (code: number, body: string): Responder =>
  (response) => {
    response.writeHead(code, { 'content-type': 'application/json' });
    response.end(body);
  };
const hang: Responder = () => {};
const after =
  (ms: number, responder: Responder): Responder =>
  (response) => {
    setTimeout(() => responder(response), ms);
  };

function activityAnswer(camel: string) {
  return {
    activity: {
      title: 'Camel and tent',
      purpose: 'Practice saying where things are in Korean, using your desert camp.',
      instruction: {
        text: '낙타를 텐트 왼쪽에 놓고 한국어로 말해 보세요.',
        language: 'ko',
        gloss: 'Put the camel to the left of the tent, then say it in Korean.',
      },
      components: [
        {
          type: 'arrange',
          axis: { kind: 'viewer-left-right' },
          tokens: [
            { key: 'a', label: { text: '낙타', language: 'ko', gloss: 'camel' }, sourceId: camel },
            { key: 'b', label: { text: '텐트', language: 'ko', gloss: 'tent' }, sourceId: null },
          ],
          target: { subject: 'a', relation: 'left-of', object: 'b' },
        },
        {
          type: 'sequence',
          joiner: 'space',
          language: 'ko',
          tiles: [
            { key: 't1', text: '낙타가' },
            { key: 't2', text: '텐트' },
            { key: 't3', text: '왼쪽에' },
            { key: 't4', text: '있어요' },
            { key: 't5', text: '오른쪽에' },
          ],
        },
      ],
      hints: [{ text: 'Start with the camel, then say where it is.', language: 'en', gloss: null }],
    },
    fallbackText: 'Picture the camel to the left of the tent and say it in Korean.',
  };
}

function replyAnswer(next: unknown = null) {
  return {
    reply: {
      summary: { text: 'Synthetic summary of the attempt.', language: 'en', gloss: null },
      points: [{ about: 'sequence', text: 'Synthetic point about the sentence.', language: 'en' }],
    },
    next,
  };
}

async function setup(options: { timeoutMs?: number; prepared?: boolean } = {}) {
  const journal = Journal.open(':memory:');
  const test = testBoopy({ journal });
  const session = await test.boopy.start(startRequest('Synthetic camel and tent.'));
  const packageId = test.boopy.commit(session.id).committed?.packageId;
  assert.ok(packageId);
  const sources = allowedSources(test.boopy.package(packageId), test.boopy.supersessions);
  const camel = sources.find((source) => source.label === 'Camels');
  assert.ok(camel);
  const ids = new Map<string, number>();
  let clock = Date.parse('1970-01-01T09:00:00.000Z');
  const dependencies = {
    journal,
    now: () => {
      clock += 1000;
      return new Date(clock);
    },
    newId: (prefix: 'arq' | 'act' | 'sub' | 'rep' | 'cal') => {
      const next = (ids.get(prefix) ?? 0) + 1;
      ids.set(prefix, next);
      return `${prefix}_k${next}`;
    },
    preparation: {
      forPackage: () => {
        if (options.prepared === false) throw new Error('Prepared handoff unavailable.');
        return {
          sessionId: session.id,
          requestId: 'synthetic-preparation-1',
          receiptId: 'receipt_synthetic',
          sourceState: 'unchanged',
          receipt: { packetSha256: sha256(PACKET) },
        } as unknown as ReturnType<HandoffPreparation['forPackage']>;
      },
      readPacket: async () => PACKET,
    },
    packageForId: (id: string) => test.boopy.package(id),
    supersessions: () => test.boopy.supersessions,
  };
  const ollama = await FakeOllama.start();
  const store = new ActivityStore(dependencies);
  const assistant = new OllamaActivityAssistant({ url: ollama.url, model: MODEL });
  const calls = new ActivityCalls({ store, assistant, timeoutMs: options.timeoutMs ?? 5000 });
  return {
    ...test,
    journal,
    sessionId: session.id,
    packageId,
    camel: camel.sourceId,
    dependencies,
    ollama,
    store,
    calls,
    ask: () => calls.askForPractice({ packageId, goal: GOAL }),
    /** A fresh store on the same journal, as after a restart. */
    restart: () => new ActivityStore(dependencies),
    close: async () => {
      await calls.close(0);
      await ollama.close();
    },
  };
}
type Setup = Awaited<ReturnType<typeof setup>>;

function eventsOf(journal: Journal, type: string) {
  return journal
    .all()
    .filter((event) => event.type === type)
    .map((event) => ({
      actor: event.actor,
      data: event.data as unknown as Record<string, unknown>,
    }));
}

/** The user message is the file's instructions, a blank line and the exact rendered file. */
function sentFile(s: Setup, index: number) {
  const user = s.ollama.requests[index]?.body.messages[1];
  assert.equal(user?.role, 'user');
  const split = user.content.indexOf('\n\n{');
  assert.ok(split > 0);
  const text = user.content.slice(split + 2);
  return { text, preamble: user.content.slice(0, split), value: JSON.parse(text) };
}

/** A practice call that imported a valid activity, with its arrangement placed. */
async function calledActivity(s: Setup) {
  s.ollama.answer(answerWith(activityAnswer(s.camel)));
  const done = await s.calls.finished((await s.ask()).callId);
  assert.equal(done.state, 'imported');
  assert.ok(done.activityId);
  s.store.arrange(done.activityId, { revision: 0, positions: { a: 0.2, b: 0.7 } });
  return done.activityId;
}

describe('Boopy asks the local model itself (section 11)', () => {
  it('does not relabel a later file import of called artifact bytes as Boopy-called', async () => {
    const s = await setup();
    try {
      const calledId = await calledActivity(s);
      const request = ActivityRequestFile.parse(sentFile(s, 0).value);
      const answer = activityAnswer(s.camel);
      const content = `${JSON.stringify({ type: 'boopy.activity', version: 1, binding: request.respondWith.binding, activity: answer.activity, fallbackText: answer.fallbackText }, null, 2)}\n`;
      const manual = s.store.importActivity(content);
      assert.notEqual(manual.activityId, calledId);
      assert.equal(s.store.view(manual.activityId).provenance.authorship, 'claimed-by-file');
      assert.equal(s.store.view(calledId).provenance.authorship, 'called-by-boopy');
      assert.equal(s.store.importActivity(content).activityId, manual.activityId);
      assert.deepEqual(s.restart().list(), s.store.list());
    } finally {
      await s.close();
    }
  });
  it('keeps a manual import distinct when identical answer bytes arrive during a call', async () => {
    const s = await setup();
    try {
      const answer = activityAnswer(s.camel);
      s.ollama.answer(after(100, answerWith(answer)));
      const call = await s.ask();
      await until(() => s.ollama.requests.length === 1);
      const request = ActivityRequestFile.parse(sentFile(s, 0).value);
      const content = `${JSON.stringify({ type: 'boopy.activity', version: 1, binding: request.respondWith.binding, activity: answer.activity, fallbackText: answer.fallbackText }, null, 2)}\n`;
      const manual = s.store.importActivity(content);
      const done = await s.calls.finished(call.callId);
      assert.equal(done.state, 'imported');
      assert.notEqual(done.activityId, manual.activityId);
      assert.equal(s.store.view(manual.activityId).provenance.authorship, 'claimed-by-file');
      assert.ok(done.activityId);
      assert.equal(s.store.view(done.activityId).provenance.authorship, 'called-by-boopy');
      assert.equal(s.store.importActivity(content).activityId, manual.activityId);
      assert.deepEqual(s.restart().calls(), s.store.calls());
    } finally {
      await s.close();
    }
  });
  it('bounds and aborts metadata preflight on timeout and stop without sending a prompt', async () => {
    for (const stop of [false, true]) {
      const s = await setup({ timeoutMs: 100 });
      try {
        s.ollama.metadataHangs = true;
        const call = await s.ask();
        if (stop) {
          await sleep(20);
          await s.calls.close(0);
        }
        const done = await s.calls.finished(call.callId);
        await until(() => s.ollama.aborted === 1);
        assert.equal(s.ollama.requests.length, 0);
        assert.equal(done.state, stop ? 'running' : 'failed');
        if (!stop) assert.equal(done.failure?.code, 'assistant_timeout');
      } finally {
        await s.close();
      }
    }
  });

  it('refuses replayed call provenance that does not name the pending call', async () => {
    const s = await setup();
    const journal = Journal.open(':memory:');
    try {
      await calledActivity(s);
      for (const event of s.journal.all()) {
        const changed = structuredClone(event);
        if (changed.type === 'activity.imported' && changed.data.call)
          changed.data.call.callId = 'cal_unknown';
        journal.append(changed, changed.id, changed.at);
      }
      assert.throws(() => new ActivityStore({ journal }), /does not fit/);
    } finally {
      journal.close();
      await s.close();
    }
  });
  it('replays valid historical model names and refuses raw names that need normalization or contain links', async () => {
    const s = await setup();
    try {
      const activityId = await calledActivity(s);
      for (const [model, valid] of [
        ['historical/local_model:1.0', true],
        ['q'.repeat(45), true],
        [` ${MODEL}`, false],
        [`${MODEL} `, false],
        [`${MODEL}\n`, false],
        ['synthetic://model', false],
        ['www.synthetic', false],
        ['file:synthetic', false],
      ] as const) {
        const journal = Journal.open(':memory:');
        try {
          for (const event of s.journal.all()) {
            const changed = structuredClone(event);
            if (changed.type === 'activity.call-asked') changed.data.model = model;
            if (changed.type === 'activity.imported' && changed.data.call)
              changed.data.call.model = model;
            journal.append(changed, changed.id, changed.at);
          }
          const replay = () => new ActivityStore({ journal });
          if (valid) {
            const store = replay();
            assert.equal(store.view(activityId).provenance.call?.model, model);
            assert.equal(ActivityCallView.parse(store.calls()[0]).model, model);
          } else assert.throws(replay, /does not fit/, model);
        } finally {
          journal.close();
        }
      }
    } finally {
      await s.close();
    }
  });
  it('produces the synthetic called activity and reply fixture used by headset tests', async () => {
    const s = await setup();
    try {
      const activityId = await calledActivity(s);
      s.ollama.answer(answerWith(replyAnswer(activityAnswer(s.camel))));
      const callId = s.calls.submit(activityId, { revision: 1 }).submissions.at(-1)
        ?.replyCall?.callId;
      assert.ok(callId);
      await s.calls.finished(callId);
      const view = s.store.view(activityId);
      // Wall time is measured in production. Only these two measurement fields are fixed for
      // the portable synthetic fixture; every ID, binding, state and hash comes from the store.
      assert.ok(view.provenance.call);
      view.provenance.call.durationMs = 1500;
      const reply = view.submissions.at(-1)?.reply;
      assert.ok(reply?.call);
      reply.call.durationMs = 1500;
      const fixture = new URL('../fixtures/activity/called-with-reply.json', import.meta.url);
      if (process.env.BOOPY_UPDATE_ACTIVITY_FIXTURE === '1')
        writeFileSync(fixture, `${JSON.stringify(view, null, 2)}\n`);
      assert.deepEqual(view, ActivityView.parse(JSON.parse(readFileSync(fixture, 'utf8'))));
    } finally {
      await s.close();
    }
  });
  it('refuses remote, missing and changed model metadata before sending any prompt', async () => {
    const s = await setup();
    try {
      for (const models of [
        [],
        [{ ...LOCAL_MODEL, remote_model: MODEL, remote_host: 'https://cloud.invalid' }],
        [{ ...LOCAL_MODEL, digest: 'a'.repeat(64) }],
        [{ ...LOCAL_MODEL, size: 0 }],
        [{ ...LOCAL_MODEL, details: { format: 'remote' } }],
      ]) {
        s.ollama.models = models;
        const done = await s.calls.finished((await s.ask()).callId);
        assert.equal(done.failure?.code, 'assistant_error');
        assert.equal(s.ollama.requests.length, 0);
      }
      s.ollama.models = [LOCAL_MODEL];
      for (const show of [
        { ...LOCAL_SHOW, remote_model: MODEL },
        {},
        {
          ...LOCAL_SHOW,
          model_info: { 'general.architecture': 'other', 'general.parameter_count': 35951479808 },
        },
      ]) {
        s.ollama.show = show;
        const done = await s.calls.finished((await s.ask()).callId);
        assert.equal(done.failure?.code, 'assistant_error');
        assert.equal(s.ollama.requests.length, 0);
      }
      assert.deepEqual(s.store.list(), []);
    } finally {
      await s.close();
    }
  });
  it('a practice request sends the rendered request once and imports a valid answer as Boopy-called', async () => {
    const s = await setup();
    try {
      s.ollama.answer(answerWith(activityAnswer(s.camel)));
      const asked = await s.ask();
      ActivityCallView.parse(asked);
      assert.equal(asked.kind, 'activity');
      assert.equal(asked.state, 'running');
      assert.equal(asked.provider, 'ollama');
      assert.equal(asked.model, MODEL);
      assert.equal(asked.packageId, s.packageId);
      const done = await s.calls.finished(asked.callId);
      ActivityCallView.parse(done);
      assert.equal(done.state, 'imported');
      assert.equal(done.failure, null);
      assert.deepEqual(done.issues, []);
      assert.ok(done.activityId);
      assert.ok(Number.isInteger(done.durationMs) && (done.durationMs ?? -1) >= 0);

      assert.equal(s.ollama.requests.length, 1);
      const [sent] = s.ollama.requests;
      assert.equal(sent?.method, 'POST');
      assert.equal(sent?.url, '/api/chat');
      assert.equal(sent?.body.model, MODEL);
      assert.equal(sent?.body.stream, false);
      assert.equal(sent?.body.think, false);
      assert.equal(sent?.body.keep_alive, '30m');
      assert.deepEqual(sent?.body.options, { temperature: 0.2, num_predict: 8192 });
      assert.equal(sent && 'format' in sent.body, false);
      const system = sent?.body.messages[0];
      assert.equal(system?.role, 'system');
      assert.match(
        system?.content ?? '',
        /Answer with one JSON object, and nothing else, that matches this JSON Schema:\n\{/,
      );

      const file = sentFile(s, 0);
      const request = ActivityRequestFile.parse(file.value);
      assert.equal(file.preamble, request.instructions.join('\n'));
      assert.equal(request.delivery, 'sent-by-boopy-to-local-model');
      assert.match(request.note, /Boopy sent this request to the local model on this Mac\./);
      assert.equal(request.goal, GOAL);
      assert.equal(request.context.packet, PACKET);
      assert.equal(request.requestId, done.requestId);
      const [prepared] = eventsOf(s.journal, 'activity.request-prepared');
      assert.equal(prepared?.actor, 'person');
      assert.equal(prepared?.data.delivery, 'sent-to-local-model');
      assert.equal(prepared?.data.fileSha256, sha256(file.text));

      const view = ActivityView.parse(s.store.view(done.activityId));
      assert.equal(view.status, 'active');
      assert.equal(view.provenance.authorship, 'called-by-boopy');
      assert.equal(view.provenance.claimedAuthor, null);
      assert.equal(view.provenance.requestId, done.requestId);
      assert.deepEqual(view.provenance.call, {
        callId: asked.callId,
        provider: 'ollama',
        model: MODEL,
        durationMs: done.durationMs,
      });
      const [summary] = s.store.list();
      ActivitySummary.parse(summary);
      assert.deepEqual(summary?.call, { provider: 'ollama', model: MODEL });
      assert.equal(summary?.claimedAuthor, null);

      const types = s.journal
        .all()
        .map((event) => event.type)
        .filter((type) => type.startsWith('activity.'));
      assert.deepEqual(types, [
        'activity.request-prepared',
        'activity.call-asked',
        'activity.imported',
        'activity.call-finished',
      ]);
      const [callAsked] = eventsOf(s.journal, 'activity.call-asked');
      assert.equal(callAsked?.actor, 'person');
      assert.deepEqual(callAsked?.data, {
        callId: asked.callId,
        kind: 'activity',
        provider: 'ollama',
        model: MODEL,
        requestId: done.requestId,
        submissionId: null,
        fileSha256: sha256(file.text),
      });
      const [imported] = eventsOf(s.journal, 'activity.imported');
      assert.equal(imported?.actor, 'system');
      assert.equal(imported?.data.claimedAuthor, null);
      assert.deepEqual(imported?.data.call, view.provenance.call);
      const [finished] = eventsOf(s.journal, 'activity.call-finished');
      assert.equal(finished?.actor, 'system');
      assert.deepEqual(finished?.data, {
        callId: asked.callId,
        outcome: 'imported',
        durationMs: done.durationMs,
        failure: null,
        issues: [],
        activityId: done.activityId,
        replyId: null,
        nextActivityId: null,
        metrics: {
          totalMs: 1500,
          loadMs: 16,
          promptEvalMs: 780,
          evalMs: 615,
          promptTokens: 3386,
          outputTokens: 712,
        },
      });
      // Call events never carry prompt or answer text.
      for (const type of ['activity.call-asked', 'activity.call-finished'])
        for (const event of eventsOf(s.journal, type))
          assert.doesNotMatch(JSON.stringify(event.data), /camel|낙타|Synthetic prepared packet/i);
    } finally {
      await s.close();
    }
  });

  it('ignores any binding, echo, author or type the model writes', async () => {
    const s = await setup();
    try {
      s.ollama.answer(
        answerWith({
          ...activityAnswer(s.camel),
          type: 'boopy.activity',
          version: 1,
          binding: { requestId: 'arq_other', packageId: 'ctx_other', packetSha256: 'a'.repeat(64) },
          echo: 'synthetic',
          author: 'Grok Bot',
        }),
      );
      const done = await s.calls.finished((await s.ask()).callId);
      assert.equal(done.state, 'imported');
      assert.ok(done.activityId);
      const view = s.store.view(done.activityId);
      assert.equal(view.provenance.claimedAuthor, null);
      assert.equal(view.provenance.requestId, done.requestId);
      assert.equal(view.provenance.authorship, 'called-by-boopy');
    } finally {
      await s.close();
    }
  });

  it('reads the answer with the section 2 container rules', async () => {
    const s = await setup();
    try {
      const json = JSON.stringify(activityAnswer(s.camel), null, 2);
      for (const content of [
        `\`\`\`json\n${json}\n\`\`\``,
        `Here it is.\n\`\`\`json\n${json}\n\`\`\``,
      ]) {
        s.ollama.answer(chat(content));
        const done = await s.calls.finished((await s.ask()).callId);
        assert.equal(done.state, 'imported');
      }
      const unreadable = [
        'Here is a camel and tent activity for you.',
        `\`\`\`json\n${json}\n\`\`\`\n\`\`\`json\n${json}\n\`\`\``,
        `\`\`\`jsonc\n${json}\n\`\`\``,
        '{"activity": {}, "activity": {}, "fallbackText": "Synthetic."}',
        '{"__proto__": {}, "fallbackText": "Synthetic."}',
        '["not", "an", "object"]',
      ];
      for (const content of unreadable) {
        s.ollama.answer(chat(content));
        const done = await s.calls.finished((await s.ask()).callId);
        assert.equal(done.state, 'failed');
        assert.deepEqual(done.failure, {
          code: 'answer_unreadable',
          message: `${PRACTICE}its answer wasn't one JSON object.`,
        });
        assert.deepEqual(done.issues, []);
        assert.equal(done.activityId, null);
      }
      assert.equal(s.store.list().length, 2);
      assert.equal(eventsOf(s.journal, 'activity.imported').length, 2);
    } finally {
      await s.close();
    }
  });

  it('an answer that does not fit the format imports nothing and fails with its issues', async () => {
    const s = await setup();
    try {
      const valid = activityAnswer(s.camel);
      const [arrange, sequence] = valid.activity.components;
      const answers = [
        { fallbackText: valid.fallbackText },
        { activity: valid.activity },
        { ...valid, fallbackText: 'See https://example.invalid for more.' },
        { ...valid, fallbackText: '' },
        {
          ...valid,
          activity: {
            ...valid.activity,
            components: [
              { ...arrange, tokens: [{ key: 'a', label: { text: '낙타', language: 'ko' } }] },
            ],
          },
        },
        { ...valid, activity: { ...valid.activity, components: [sequence, sequence] } },
        {
          ...valid,
          activity: { ...valid.activity, components: [{ type: 'map', places: [] }] },
        },
      ];
      for (const answer of answers) {
        s.ollama.answer(answerWith(answer));
        const done = await s.calls.finished((await s.ask()).callId);
        assert.equal(done.state, 'failed');
        assert.deepEqual(done.failure, {
          code: 'answer_invalid',
          message: `${PRACTICE}its answer didn't fit Boopy's format.`,
        });
        assert.ok(done.issues.length >= 1 && done.issues.length <= 8);
        for (const issue of done.issues) assert.match(issue, /^[^\n]+: [^\n]+$/);
        assert.equal(done.activityId, null);
      }
      assert.deepEqual(s.store.list(), []);
      assert.equal(eventsOf(s.journal, 'activity.imported').length, 0);
      assert.equal(eventsOf(s.journal, 'activity.call-finished').length, answers.length);
    } finally {
      await s.close();
    }
  });

  it('a local model error fails the call once and nothing is retried', async () => {
    const s = await setup();
    try {
      const errors: Responder[] = [
        status(500, '{"error":"synthetic failure"}'),
        status(501, '{"error":"structured output is unavailable"}'),
        status(200, 'not json'),
        status(200, '{"model":"synthetic","done":true}'),
        status(
          200,
          JSON.stringify({ message: { role: 'assistant', content: 'x'.repeat(1_100_000) } }),
        ),
      ];
      for (const [index, error] of errors.entries()) {
        s.ollama.answer(error);
        const done = await s.calls.finished((await s.ask()).callId);
        assert.equal(done.state, 'failed');
        assert.deepEqual(done.failure, {
          code: 'assistant_error',
          message: `${PRACTICE}the local model reported an error.`,
        });
        assert.equal(s.ollama.requests.length, index + 1);
      }
      assert.deepEqual(s.store.list(), []);
    } finally {
      await s.close();
    }
  });

  it('an unreachable local model fails the call', async () => {
    const s = await setup();
    const gone = await FakeOllama.start();
    const url = gone.url;
    await gone.close();
    const calls = new ActivityCalls({
      store: s.store,
      assistant: new OllamaActivityAssistant({ url, model: MODEL }),
      timeoutMs: 5000,
    });
    try {
      const done = await calls.finished(
        (await calls.askForPractice({ packageId: s.packageId, goal: GOAL })).callId,
      );
      assert.equal(done.state, 'failed');
      assert.deepEqual(done.failure, {
        code: 'assistant_unreachable',
        message: `${PRACTICE}the local model isn't answering on this Mac.`,
      });
    } finally {
      await calls.close(0);
      await s.close();
    }
  });
});
