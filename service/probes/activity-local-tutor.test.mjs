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
  const closed = createServer();
  await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
  const port = closed.address().port;
  await new Promise((resolve) => closed.close(resolve));
  const directory = await scratch(t);
  const result = await runProbe([
    'activity',
    '--request',
    REQUEST,
    '--out',
    join(directory, 'activity.json'),
    '--url',
    `http://127.0.0.1:${port}`,
  ]);
  assert.equal(result.code, 1);
  assert.equal(summaryOf(result).outcome, 'ollama-unreachable');
});

test('an Ollama response body over 32 MiB is refused without retry, with or without a declared length', async (t) => {
  const limit = 32 * 1024 * 1024;
  const answer = JSON.stringify({
    model: MODEL,
    message: {
      role: 'assistant',
      content: JSON.stringify({ ...activityAnswer, fallbackText: 'OUTPUT-MARKER-4e2a' }),
    },
    done: true,
    done_reason: 'stop',
  });
  // Trailing whitespace keeps the body valid JSON at any size.
  const declared = (size) => (outgoing) => {
    const body = answer + ' '.repeat(size - Buffer.byteLength(answer));
    outgoing.writeHead(200, { 'content-type': 'application/json', 'content-length': size });
    outgoing.end(body);
  };
  // No length at all: 1 MiB chunks until the probe hangs up, at most 64 MiB.
  const endless = async (outgoing) => {
    outgoing.writeHead(200, { 'content-type': 'application/json' });
    const chunk = Buffer.alloc(1024 * 1024, 0x20);
    for (let sent = 0; sent < 64 && !outgoing.destroyed; sent++)
      if (!outgoing.write(chunk) && !outgoing.destroyed)
        await new Promise((resolve) => {
          outgoing.once('drain', resolve);
          outgoing.once('close', resolve);
        });
    if (!outgoing.destroyed) outgoing.end();
  };
  const cases = [
    { name: 'declared, one byte over', respond: declared(limit + 1), code: 1 },
    { name: 'chunked without a length', respond: endless, code: 1 },
    { name: 'exactly 32 MiB', respond: declared(limit), code: 0 },
  ];
  for (const { name, respond, code } of cases) {
    const directory = await scratch(t);
    const ollama = await fakeOllama(t, respond);
    const out = join(directory, 'activity.json');
    const result = await runProbe(
      [
        'activity',
        '--request',
        REQUEST,
        '--out',
        out,
        '--url',
        ollama.url,
        '--deadline-ms',
        '30000',
      ],
      60_000,
    );
    assert.equal(result.code, code, `${name}: ${result.stderr}`);
    const summary = summaryOf(result);
    assert.equal(ollama.requests.length, 1, name);
    assert.equal(summary.modelCalls, 1, name);
    assert.ok(!`${result.stdout}${result.stderr}`.includes('OUTPUT-MARKER'), name);
    if (code === 0) {
      assert.equal(summary.outcome, 'written', name);
      assert.equal(summary.responseBytes, limit, name);
      assert.equal(await exists(out), true, name);
    } else {
      assert.equal(summary.outcome, 'response-too-large', name);
      assert.ok(summary.responseBytes > limit, name);
      assert.ok(summary.responseBytes < limit + 4 * 1024 * 1024, `${name}: stops near the cap`);
      assert.match(result.stderr, /32 MiB/, name);
      assert.equal(await exists(out), false, name);
    }
  }
});

test('the output is a new file with mode 0600, created exclusively', async (t) => {
  const directory = await scratch(t);
  const ollama = await fakeOllama(t, answering(activityAnswer));
  const run = (out) =>
    runProbe(['activity', '--request', REQUEST, '--out', out, '--url', ollama.url]);
  const previous = process.umask(0);
  let written;
  try {
    written = await run(join(directory, 'open-umask.json'));
  } finally {
    process.umask(previous);
  }
  assert.equal(written.code, 0, written.stderr);
  assert.equal((await stat(join(directory, 'open-umask.json'))).mode & 0o777, 0o600);
  assert.equal(ollama.requests.length, 1);

  const taken = join(directory, 'taken.json');
  await writeFile(taken, 'existing');
  const dangling = join(directory, 'dangling.json');
  await symlink(join(directory, 'missing-target.json'), dangling);
  for (const [out, reason] of [
    [taken, 'output-exists'],
    [dangling, 'output-exists'],
    [join(directory, 'missing-folder', 'activity.json'), 'output-directory-missing'],
  ]) {
    const result = await run(out);
    assert.equal(result.code, 2, out);
    assert.equal(summaryOf(result).reason, reason);
    assert.equal(summaryOf(result).modelCalls, 0);
  }
  assert.equal(ollama.requests.length, 1, 'No model call for an output that cannot be written.');
  assert.equal(await readFile(taken, 'utf8'), 'existing');
  assert.ok((await lstat(dangling)).isSymbolicLink());
  assert.equal(await exists(join(directory, 'missing-target.json')), false);
});

test('an output that appears during the model call is left untouched', async (t) => {
  const directory = await scratch(t);
  const out = join(directory, 'activity.json');
  const answer = answering(activityAnswer);
  const ollama = await fakeOllama(t, async (outgoing) => {
    await writeFile(out, 'raced');
    answer(outgoing);
  });
  const result = await runProbe([
    'activity',
    '--request',
    REQUEST,
    '--out',
    out,
    '--url',
    ollama.url,
  ]);
  assert.equal(result.code, 1);
  assert.equal(summaryOf(result).outcome, 'output-exists');
  assert.equal(ollama.requests.length, 1);
  assert.equal(await readFile(out, 'utf8'), 'raced');
});

test('oversized, linked, irregular, non-UTF-8, non-JSON and mismatched inputs are refused before any call', async (t) => {
  const directory = await scratch(t);
  const ollama = await fakeOllama(t, answering(activityAnswer));
  const file = async (name, content) => {
    const path = join(directory, name);
    await writeFile(path, content);
    return path;
  };
  const padded = (bytes) =>
    requestText.trimEnd() + ' '.repeat(bytes - Buffer.byteLength(requestText.trimEnd()));
  const changed = (text, change) => {
    const value = JSON.parse(text);
    change(value);
    return JSON.stringify(value);
  };
  const linked = join(directory, 'linked.json');
  await symlink(REQUEST, linked);
  const folder = join(directory, 'folder.json');
  await mkdir(folder);
  const fifo = join(directory, 'fifo.json');
  execFileSync('mkfifo', [fifo]);
  const cases = [
    ['activity', await file('large.json', padded(64 * 1024 + 1)), 'input-too-large'],
    ['activity', linked, 'input-symlink'],
    ['activity', folder, 'input-not-regular'],
    ['activity', fifo, 'input-not-regular'],
    ['activity', join(directory, 'absent.json'), 'input-unreadable'],
    ['activity', await file('latin1.json', Buffer.from([0x7b, 0xff, 0x7d])), 'input-not-utf8'],
    ['activity', await file('prose.json', 'Please make me an activity.'), 'input-not-json'],
    ['activity', await file('array.json', '[1, 2, 3]'), 'input-not-json'],
    ['reply', REQUEST, 'input-wrong-type'],
    ['activity', SUBMISSION, 'input-wrong-type'],
    [
      'activity',
      await file(
        'other-binding.json',
        changed(requestText, (value) => {
          value.respondWith.binding.requestId = 'arq_other';
        }),
      ),
      'binding-mismatch',
    ],
    [
      'activity',
      await file(
        'extra-binding.json',
        changed(requestText, (value) => {
          value.respondWith.binding.extra = 'x';
        }),
      ),
      'input-malformed',
    ],
    [
      'activity',
      await file(
        'no-instructions.json',
        changed(requestText, (value) => {
          delete value.instructions;
        }),
      ),
      'input-malformed',
    ],
    [
      'reply',
      await file(
        'other-echo.json',
        changed(submissionText, (value) => {
          value.respondWith.echo = 'hints: 0 of 2';
        }),
      ),
      'binding-mismatch',
    ],
    [
      'reply',
      await file(
        'other-submission.json',
        changed(submissionText, (value) => {
          value.respondWith.binding.submissionId = 'sub_other';
        }),
      ),
      'binding-mismatch',
    ],
  ];
  for (const [index, [mode, input, reason]] of cases.entries()) {
    const out = join(directory, `out-${index}.json`);
    const flag = mode === 'activity' ? '--request' : '--submission';
    const result = await runProbe([mode, flag, input, '--out', out, '--url', ollama.url], 10_000);
    assert.equal(result.code, 2, reason);
    assert.equal(summaryOf(result).reason, reason, `${index} ${reason}`);
    assert.equal(await exists(out), false, reason);
  }
  assert.equal(ollama.requests.length, 0);

  const limit = join(directory, 'limit-out.json');
  const exact = await file('exact.json', padded(64 * 1024));
  const accepted = await runProbe([
    'activity',
    '--request',
    exact,
    '--out',
    limit,
    '--url',
    ollama.url,
  ]);
  assert.equal(accepted.code, 0, accepted.stderr);
  assert.equal(summaryOf(accepted).inputBytes, 64 * 1024);
  assert.equal(ollama.requests.length, 1);
});

test('usage errors and non-loopback Ollama addresses are refused without a call', async (t) => {
  const directory = await scratch(t);
  const ollama = await fakeOllama(t, answering(activityAnswer));
  const out = join(directory, 'activity.json');
  const cases = [
    [[], 'usage'],
    [['lesson', '--request', REQUEST, '--out', out], 'usage'],
    [['activity', '--request', REQUEST], 'usage'],
    [['activity', '--submission', SUBMISSION, '--out', out], 'usage'],
    [['reply', '--submission', SUBMISSION, '--request', REQUEST, '--out', out], 'usage'],
    [['activity', '--request', REQUEST, '--out', out, '--retries', '2'], 'usage'],
    [['activity', '--request', REQUEST, '--out', out, '--deadline-ms', '0'], 'usage'],
    [['activity', '--request', REQUEST, '--out', out, '--deadline-ms', '1.5'], 'usage'],
    [['activity', '--request', REQUEST, '--out', out, '--deadline-ms', '600001'], 'usage'],
    [
      ['activity', '--request', REQUEST, '--out', out, '--url', 'http://192.0.2.1:11434'],
      'url-not-loopback',
    ],
    [
      ['activity', '--request', REQUEST, '--out', out, '--url', 'https://127.0.0.1:11434'],
      'url-not-loopback',
    ],
    [
      ['activity', '--request', REQUEST, '--out', out, '--url', `${ollama.url}/api`],
      'url-not-loopback',
    ],
    [
      ['activity', '--request', REQUEST, '--out', out, '--url', 'http://user:pw@127.0.0.1:1'],
      'url-not-loopback',
    ],
  ];
  for (const [args, reason] of cases) {
    const result = await runProbe(args);
    assert.equal(result.code, 2, args.join(' '));
    const summary = summaryOf(result);
    assert.equal(summary.outcome, 'refused');
    assert.equal(summary.reason, reason, args.join(' '));
    assert.equal(summary.modelCalls, 0);
  }
  assert.equal(ollama.requests.length, 0);
  assert.equal(await exists(out), false);
});
