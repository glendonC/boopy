import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { activityAnswerSchema, authorFor, replyAnswerSchema } from './activity-local-tutor.mjs';

const PROBE = fileURLToPath(new URL('./activity-local-tutor.mjs', import.meta.url));
const FIXTURES = fileURLToPath(new URL('./fixtures/activity-tutor/', import.meta.url));
const REQUEST = join(FIXTURES, 'boopy-activity-request-arq_tutor_ko1.json');
const SUBMISSION = join(FIXTURES, 'boopy-activity-submission-sub_tutor_ko1.json');
const requestText = readFileSync(REQUEST, 'utf8');
const submissionText = readFileSync(SUBMISSION, 'utf8');
const request = JSON.parse(requestText);
const submission = JSON.parse(submissionText);
const MODEL = 'qwen3.6:35b-a3b-nvfp4';
const AUTHOR = `Ollama ${MODEL} (local)`;
const SUBMITTED_SOURCES = ['ctx_synthetic_tutor1:itm_1', 'ctx_synthetic_tutor1:itm_2'];

const activityAnswer = {
  activity: {
    title: 'Synthetic title',
    purpose: 'Synthetic purpose.',
    instruction: { text: 'Synthetic instruction.', language: 'en', gloss: null },
    components: [
      {
        type: 'arrange',
        axis: { kind: 'scale', low: 'Low', high: 'High' },
        tokens: [
          { key: 'a', label: { text: 'one', language: 'en', gloss: null }, sourceId: null },
          { key: 'b', label: { text: 'two', language: 'en', gloss: null }, sourceId: null },
        ],
        target: null,
      },
    ],
    hints: [],
  },
  fallbackText: 'Synthetic fallback text.',
};
const replyAnswer = {
  reply: {
    summary: { text: 'Synthetic summary.', language: 'en', gloss: null },
    points: [{ about: 'overall', text: 'Synthetic point.', language: 'en', gloss: null }],
  },
  next: null,
};

/** A stand-in for Ollama's chat API on a random loopback port; it records every request. */
async function fakeOllama(t, respond) {
  const requests = [];
  const server = createServer(async (incoming, outgoing) => {
    let body = '';
    for await (const chunk of incoming) body += chunk;
    requests.push({ method: incoming.method, url: incoming.url, body: JSON.parse(body) });
    await respond(outgoing, requests.length);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}

/** Ollama's non-streaming chat response carrying `content` as the model's message. */
function answering(content, extra = {}) {
  return (outgoing) => {
    outgoing.setHeader('content-type', 'application/json');
    outgoing.end(
      JSON.stringify({
        model: MODEL,
        created_at: '1970-01-01T12:00:00Z',
        message: {
          role: 'assistant',
          content: typeof content === 'string' ? content : JSON.stringify(content),
        },
        done: true,
        done_reason: 'stop',
        total_duration: 2_500_000_000,
        load_duration: 400_000_000,
        prompt_eval_count: 900,
        prompt_eval_duration: 700_000_000,
        eval_count: 300,
        eval_duration: 1_300_000_000,
        ...extra,
      }),
    );
  };
}

function runProbe(args, timeout = 20_000) {
  return new Promise((resolve) => {
    execFile(process.execPath, [PROBE, ...args], { timeout }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : -1;
      resolve({ code, stdout, stderr });
    });
  });
}

function summaryOf(result) {
  const lines = result.stdout.split('\n').filter((line) => line !== '');
  assert.equal(lines.length, 1, 'The probe prints exactly one summary line.');
  return JSON.parse(lines[0]);
}

async function scratch(t) {
  const directory = await mkdtemp(join(tmpdir(), 'boopy-tutor-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

const exists = (path) =>
  lstat(path).then(
    () => true,
    () => false,
  );

test('activity mode copies the binding from respondWith, labels the author and sends the schema', async (t) => {
  const directory = await scratch(t);
  const ollama = await fakeOllama(
    t,
    answering({
      ...activityAnswer,
      type: 'boopy.other',
      binding: { requestId: 'arq_model', packageId: 'ctx_model', packetSha256: '0'.repeat(64) },
      author: 'Grok Bot',
    }),
  );
  const out = join(directory, 'activity.json');
  const result = await runProbe([
    'activity',
    '--request',
    REQUEST,
    '--out',
    out,
    '--url',
    ollama.url,
  ]);
  assert.equal(result.code, 0, result.stderr);
  const file = JSON.parse(await readFile(out, 'utf8'));
  assert.deepEqual(Object.keys(file), [
    'type',
    'version',
    'binding',
    'author',
    'fallbackText',
    'activity',
  ]);
  assert.deepEqual(file, {
    type: 'boopy.activity',
    version: 1,
    binding: request.respondWith.binding,
    author: AUTHOR,
    fallbackText: activityAnswer.fallbackText,
    activity: activityAnswer.activity,
  });
  assert.equal(ollama.requests.length, 1);
  const [sent] = ollama.requests;
  assert.equal(sent.method, 'POST');
  assert.equal(sent.url, '/api/chat');
  assert.equal(sent.body.model, MODEL);
  assert.equal(sent.body.stream, false);
  assert.equal(sent.body.think, false);
  const sources = request.sources.map((source) => source.sourceId);
  assert.deepEqual(sent.body.format, activityAnswerSchema(sources));
  for (const sourceId of sources) assert.ok(JSON.stringify(sent.body.format).includes(sourceId));
  const [system, user] = sent.body.messages;
  assert.equal(sent.body.messages.length, 2);
  assert.equal(system.role, 'system');
  assert.match(system.content, /exact Boopy activity request/);
  assert.match(system.content, /mastered/);
  assert.match(system.content, /unknowns unknown/);
  assert.ok(system.content.endsWith(JSON.stringify(sent.body.format)));
  assert.equal(user.role, 'user');
  assert.equal(user.content, `${request.instructions.join('\n')}\n\n${requestText}`);
  const summary = summaryOf(result);
  assert.equal(summary.outcome, 'written');
  assert.equal(summary.mode, 'activity');
  assert.equal(summary.schemaVia, 'format');
  assert.equal(summary.modelCalls, 1);
  assert.equal(summary.outputFile, 'activity.json');
});

test('reply mode copies binding and echo from respondWith and labels the author', async (t) => {
  const next = { fallbackText: 'Synthetic next fallback.', activity: activityAnswer.activity };
  const cases = [
    { answer: { ...replyAnswer, echo: 'model echo', author: 'Grok Bot' }, next: null },
    { answer: { reply: replyAnswer.reply }, next: null },
    { answer: { reply: replyAnswer.reply, next }, next },
  ];
  for (const [index, { answer, next: expected }] of cases.entries()) {
    const directory = await scratch(t);
    const ollama = await fakeOllama(
      t,
      answering({ ...answer, binding: { submissionId: 'sub_model', activityId: 'act_model' } }),
    );
    const out = join(directory, `reply-${index}.json`);
    const result = await runProbe([
      'reply',
      '--submission',
      SUBMISSION,
      '--out',
      out,
      '--url',
      ollama.url,
    ]);
    assert.equal(result.code, 0, result.stderr);
    const file = JSON.parse(await readFile(out, 'utf8'));
    assert.deepEqual(Object.keys(file), [
      'type',
      'version',
      'binding',
      'author',
      'echo',
      'reply',
      'next',
    ]);
    assert.deepEqual(file, {
      type: 'boopy.activity-reply',
      version: 1,
      binding: submission.respondWith.binding,
      author: AUTHOR,
      echo: submission.respondWith.echo,
      reply: replyAnswer.reply,
      next: expected,
    });
    const [sent] = ollama.requests;
    assert.equal(ollama.requests.length, 1);
    assert.deepEqual(sent.body.format, replyAnswerSchema(SUBMITTED_SOURCES));
    assert.match(sent.body.messages[0].content, /exact Boopy activity submission/);
    assert.equal(
      sent.body.messages[1].content,
      `${submission.instructions.join('\n')}\n\n${submissionText}`,
    );
  }
});

test('--schema-in-prompt sends no format and keeps the schema in the system message', async (t) => {
  const directory = await scratch(t);
  const ollama = await fakeOllama(
    t,
    answering(`\`\`\`json\n${JSON.stringify(replyAnswer)}\n\`\`\``),
  );
  const out = join(directory, 'reply.json');
  const result = await runProbe([
    'reply',
    '--submission',
    SUBMISSION,
    '--out',
    out,
    '--url',
    ollama.url,
    '--schema-in-prompt',
  ]);
  assert.equal(result.code, 0, result.stderr);
  const [sent] = ollama.requests;
  assert.equal('format' in sent.body, false);
  assert.ok(
    sent.body.messages[0].content.endsWith(JSON.stringify(replyAnswerSchema(SUBMITTED_SOURCES))),
  );
  assert.equal(summaryOf(result).schemaVia, 'prompt');
  assert.deepEqual(JSON.parse(await readFile(out, 'utf8')).reply, replyAnswer.reply);
});

test('the author always names local Ollama and model names that could pass for Grok are refused', async (t) => {
  assert.equal(authorFor(MODEL), AUTHOR);
  assert.ok(authorFor('m'.repeat(45)).length <= 60);
  assert.equal(authorFor('hotel:7b'), 'Ollama hotel:7b (local)');
  for (const model of [
    'grok-2',
    'GROK:latest',
    'm'.repeat(46),
    'two words',
    'model<x>',
    'www.example',
    'a://b',
    'data:7b',
    '-model',
    '',
  ])
    assert.throws(() => authorFor(model), /Ollama model name/, model);
  const directory = await scratch(t);
  const ollama = await fakeOllama(t, answering(activityAnswer));
  const out = join(directory, 'activity.json');
  const result = await runProbe([
    'activity',
    '--request',
    REQUEST,
    '--out',
    out,
    '--url',
    ollama.url,
    '--model',
    'grok-1',
  ]);
  assert.equal(result.code, 2);
  assert.equal(summaryOf(result).reason, 'model-name');
  assert.equal(ollama.requests.length, 0);
  assert.equal(await exists(out), false);
});

test('the deadline aborts the single model call and nothing is retried', async (t) => {
  for (const stall of ['before-headers', 'mid-body']) {
    const directory = await scratch(t);
    const ollama = await fakeOllama(t, (outgoing) => {
      if (stall === 'mid-body') {
        outgoing.writeHead(200, { 'content-type': 'application/json' });
        outgoing.write('{"message":');
      }
    });
    const out = join(directory, 'activity.json');
    const started = performance.now();
    const result = await runProbe([
      'activity',
      '--request',
      REQUEST,
      '--out',
      out,
      '--url',
      ollama.url,
      '--deadline-ms',
      '300',
    ]);
    assert.ok(performance.now() - started < 10_000, stall);
    assert.equal(result.code, 1, stall);
    const summary = summaryOf(result);
    assert.equal(summary.outcome, 'deadline', stall);
    assert.equal(summary.deadlineMs, 300);
    assert.equal(summary.modelCalls, 1);
    assert.equal(ollama.requests.length, 1, stall);
    assert.equal(await exists(out), false);
  }
});

test('refusals, errors and unusable answers from the model are never retried', async (t) => {
  const cases = [
    {
      name: 'schema refused',
      respond: (outgoing) => {
        outgoing.writeHead(501, { 'content-type': 'application/json' });
        outgoing.end('{"error":"structured output is unavailable"}');
      },
      outcome: 'structured-output-unavailable',
    },
    {
      name: 'server error',
      respond: (outgoing) => {
        outgoing.writeHead(500);
        outgoing.end('{"error":"synthetic failure"}');
      },
      outcome: 'ollama-error',
    },
    { name: 'not JSON', respond: answering('Here is your activity!'), outcome: 'unparsed' },
    {
      name: 'missing fallbackText',
      respond: answering({ activity: activityAnswer.activity }),
      outcome: 'unparsed',
    },
    { name: 'array', respond: answering('[1, 2]'), outcome: 'unparsed' },
  ];
  for (const { name, respond, outcome } of cases) {
    const directory = await scratch(t);
    const ollama = await fakeOllama(t, respond);
    const out = join(directory, 'activity.json');
    const result = await runProbe([
      'activity',
      '--request',
      REQUEST,
      '--out',
      out,
      '--url',
      ollama.url,
    ]);
    assert.equal(result.code, 1, name);
    assert.equal(summaryOf(result).outcome, outcome, name);
    assert.equal(ollama.requests.length, 1, name);
    assert.equal(await exists(out), false, name);
    if (outcome === 'structured-output-unavailable')
      assert.match(result.stderr, /--schema-in-prompt/);
  }
});
