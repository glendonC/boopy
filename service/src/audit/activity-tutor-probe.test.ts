/** Adversarial checks of the local tutor probe (TUTOR U1): files, printing, bindings and URLs. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readActivityFile, readReplyFile } from '../activity-contract.ts';

const probes = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'probes');
const fixtures = join(probes, 'fixtures', 'activity-tutor');
const REQUEST = join(fixtures, 'boopy-activity-request-arq_tutor_ko1.json');
const SUBMISSION = join(fixtures, 'boopy-activity-submission-sub_tutor_ko1.json');
const MARKER = 'audit-marker-5133';

type Io = { stdout: { write(text: string): boolean }; stderr: { write(text: string): boolean } };
const probe = (await import(pathToFileURL(join(probes, 'activity-local-tutor.mjs')).href)) as {
  main(argv: string[], io: Io): Promise<number>;
};

async function run(args: string[]) {
  let stdout = '';
  let stderr = '';
  const io: Io = {
    stdout: {
      write(text) {
        stdout += text;
        return true;
      },
    },
    stderr: {
      write(text) {
        stderr += text;
        return true;
      },
    },
  };
  const code = await probe.main(args, io);
  const lines = stdout.split('\n').filter((line) => line !== '');
  assert.equal(lines.length, 1, 'one summary line');
  return { code, stdout, stderr, summary: JSON.parse(lines[0] ?? '{}') };
}

/** A loopback stand-in for Ollama's chat API that counts the calls it receives. */
async function fakeOllama(respond: () => { status?: number; body: string; location?: string }) {
  const requests: string[] = [];
  const server = createServer(async (incoming, outgoing) => {
    let body = '';
    for await (const chunk of incoming) body += chunk;
    requests.push(body);
    const answer = respond();
    outgoing.writeHead(answer.status ?? 200, {
      'content-type': 'application/json',
      ...(answer.location ? { location: answer.location } : {}),
    });
    outgoing.end(answer.body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const chat = (content: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    model: 'synthetic',
    message: {
      role: 'assistant',
      content: typeof content === 'string' ? content : JSON.stringify(content),
    },
    done: true,
    done_reason: 'stop',
    ...extra,
  });

const body = (title = 'Camel and tent') => ({
  title,
  purpose: 'Synthetic practice.',
  instruction: { text: 'Put the camel left of the tent.', language: 'en', gloss: null },
  components: [
    {
      type: 'arrange',
      axis: { kind: 'viewer-left-right' },
      tokens: [
        { key: 'a', label: { text: 'camel', language: 'en', gloss: null }, sourceId: null },
        { key: 'b', label: { text: 'tent', language: 'en', gloss: null }, sourceId: null },
      ],
      target: null,
    },
  ],
  hints: [],
});
const forged = {
  binding: { requestId: 'arq_forged', packageId: 'ctx_forged', packetSha256: '0'.repeat(64) },
  author: 'Grok Bot',
  type: 'boopy.activity-reply',
  version: 2,
  echo: 'forged echo',
};
const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );

test('audit TUTOR U1: forged binding, author, type and echo in an answer never reach the file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'boopy-audit-tutor-'));
  const activity = await fakeOllama(() => ({
    body: chat({ ...forged, activity: body(), fallbackText: 'Synthetic fallback.' }),
  }));
  const reply = await fakeOllama(() => ({
    body: chat({
      ...forged,
      reply: {
        summary: { text: 'Synthetic summary.', language: 'en', gloss: null },
        points: [{ about: 'overall', text: 'Synthetic point.', language: 'en', gloss: null }],
      },
      next: null,
    }),
  }));
  try {
    const request = JSON.parse(await readFile(REQUEST, 'utf8'));
    const out = join(directory, 'activity.json');
    const made = await run(['activity', '--request', REQUEST, '--out', out, '--url', activity.url]);
    assert.equal(made.code, 0, made.stderr);
    const content = await readFile(out, 'utf8');
    const read = readActivityFile(content);
    assert.equal(read.kind, 'read');
    if (read.kind !== 'read') return;
    assert.deepEqual(read.file.binding, request.respondWith.binding);
    assert.match(read.file.author ?? '', /^Ollama \S+ \(local\)$/);
    assert.deepEqual(Object.keys(JSON.parse(content)), [
      'type',
      'version',
      'binding',
      'author',
      'fallbackText',
      'activity',
    ]);
    assert.equal((await stat(out)).mode & 0o777, 0o600);
    const submission = JSON.parse(await readFile(SUBMISSION, 'utf8'));
    const replyOut = join(directory, 'reply.json');
    const answered = await run([
      'reply',
      '--submission',
      SUBMISSION,
      '--out',
      replyOut,
      '--url',
      reply.url,
    ]);
    assert.equal(answered.code, 0, answered.stderr);
    const replied = readReplyFile(await readFile(replyOut, 'utf8'));
    assert.equal(replied.kind, 'read');
    if (replied.kind !== 'read') return;
    assert.deepEqual(replied.file.binding, submission.respondWith.binding);
    assert.equal(replied.file.echo, submission.respondWith.echo);
    assert.equal(replied.file.echo, submission.digest);
    assert.match(replied.file.author ?? '', /^Ollama \S+ \(local\)$/);
  } finally {
    await activity.close();
    await reply.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('audit TUTOR U1: nothing from the input, the answer or an error body is ever printed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'boopy-audit-tutor-'));
  const request = JSON.parse(await readFile(REQUEST, 'utf8'));
  const input = join(directory, 'request.json');
  await writeFile(input, JSON.stringify({ ...request, goal: MARKER, background: MARKER }));
  const answers = [
    { body: chat({ activity: body(MARKER), fallbackText: MARKER }) },
    { body: chat(`not json ${MARKER}`) },
    { body: chat(`\`\`\`json\n{"broken": "${MARKER}"\n\`\`\``) },
    { status: 500, body: JSON.stringify({ error: MARKER }) },
    { status: 501, body: JSON.stringify({ error: `structured output is unavailable ${MARKER}` }) },
    { body: `${MARKER} not ollama json` },
    { body: chat({ activity: body(), fallbackText: 'x' }, { done_reason: MARKER, error: MARKER }) },
    { body: JSON.stringify({ message: { content: 42 }, error: MARKER }) },
  ];
  try {
    for (const [index, answer] of answers.entries()) {
      const ollama = await fakeOllama(() => answer);
      try {
        const result = await run([
          'activity',
          '--request',
          input,
          '--out',
          join(directory, `out-${index}.json`),
          '--url',
          ollama.url,
        ]);
        assert.equal(ollama.requests.length, 1, `case ${index}`);
        assert.equal(result.stdout.includes(MARKER), false, `stdout case ${index}`);
        assert.equal(result.stderr.includes(MARKER), false, `stderr case ${index}`);
        for (const value of Object.values(result.summary))
          assert.ok(
            value === null || ['number', 'boolean', 'string'].includes(typeof value),
            `case ${index}`,
          );
      } finally {
        await ollama.close();
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('audit TUTOR U1: unusable inputs and outputs are refused before any model call', {
  timeout: 30_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'boopy-audit-tutor-'));
  const ollama = await fakeOllama(() => ({
    body: chat({ activity: body(), fallbackText: 'Synthetic fallback.' }),
  }));
  const fresh = (name: string) => join(directory, name);
  try {
    const fifo = fresh('fifo.json');
    execFileSync('mkfifo', [fifo]);
    const folder = fresh('folder.json');
    await mkdir(folder);
    const linked = fresh('linked.json');
    await symlink(REQUEST, linked);
    const large = fresh('large.json');
    await writeFile(large, `${await readFile(REQUEST, 'utf8')}${' '.repeat(70_000)}`);
    const binary = fresh('binary.json');
    await writeFile(binary, Buffer.from([0x7b, 0xff, 0xfe, 0x7d]));
    for (const [input, reason] of [
      [fifo, 'input-not-regular'],
      ['/dev/zero', 'input-not-regular'],
      [folder, 'input-not-regular'],
      [linked, 'input-symlink'],
      [large, 'input-too-large'],
      [binary, 'input-not-utf8'],
    ] as const) {
      const out = fresh(`never-${reason}.json`);
      const result = await run(['activity', '--request', input, '--out', out, '--url', ollama.url]);
      assert.equal(result.code, 2, input);
      assert.equal(result.summary.reason, reason, input);
      assert.equal(await exists(out), false, input);
    }
    const existing = fresh('existing.json');
    await writeFile(existing, 'synthetic existing');
    const dangling = fresh('dangling.json');
    await symlink(fresh('nowhere.json'), dangling);
    const toFile = fresh('to-file.json');
    await symlink(existing, toFile);
    const toFolder = fresh('to-folder');
    await symlink(folder, toFolder);
    for (const out of [existing, dangling, toFile, toFolder, fresh('missing/out.json'), REQUEST]) {
      const result = await run([
        'activity',
        '--request',
        REQUEST,
        '--out',
        out,
        '--url',
        ollama.url,
      ]);
      assert.equal(result.code, 2, out);
    }
    assert.equal(await readFile(existing, 'utf8'), 'synthetic existing');
    assert.equal(await exists(fresh('nowhere.json')), false);
    assert.equal(ollama.requests.length, 0);
    const exact = fresh('exact.json');
    const text = await readFile(REQUEST, 'utf8');
    await writeFile(exact, `${text}${' '.repeat(64 * 1024 - Buffer.byteLength(text))}`);
    const accepted = await run([
      'activity',
      '--request',
      exact,
      '--out',
      fresh('exact-out.json'),
      '--url',
      ollama.url,
    ]);
    assert.equal(accepted.code, 0, accepted.stderr);
    assert.equal(ollama.requests.length, 1);
  } finally {
    await ollama.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('audit TUTOR U1: only plain loopback Ollama addresses are used, and redirects are refused', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'boopy-audit-tutor-'));
  const target = await fakeOllama(() => ({
    body: chat({ activity: body(), fallbackText: 'Synthetic fallback.' }),
  }));
  const redirecting = await fakeOllama(() => ({
    status: 307,
    body: '',
    location: `${target.url}/api/chat`,
  }));
  try {
    for (const url of [
      'http://127.0.0.2:11434',
      'http://localhost.:11434',
      'http://[::ffff:127.0.0.1]:11434',
      'http://0.0.0.0:11434',
      'https://127.0.0.1:11434',
      'http://user@127.0.0.1:11434',
      'http://127.0.0.1:11434/api',
      'http://127.0.0.1:11434/?x=1',
      'http://example.invalid',
      'file:///dev/null',
    ]) {
      const result = await run([
        'activity',
        '--request',
        REQUEST,
        '--out',
        join(directory, 'never.json'),
        '--url',
        url,
      ]);
      assert.equal(result.code, 2, url);
      assert.equal(result.summary.reason, 'url-not-loopback', url);
    }
    for (const model of ['grok-4', 'xai/Grok-3', 'javascript:x', 'www.example', 'http://x']) {
      const result = await run([
        'activity',
        '--request',
        REQUEST,
        '--out',
        join(directory, 'never.json'),
        '--url',
        target.url,
        '--model',
        model,
      ]);
      assert.equal(result.code, 2, model);
    }
    const out = join(directory, 'redirected.json');
    const result = await run([
      'activity',
      '--request',
      REQUEST,
      '--out',
      out,
      '--url',
      redirecting.url,
    ]);
    assert.equal(result.code, 1);
    assert.equal(redirecting.requests.length, 1);
    assert.equal(target.requests.length, 0);
    assert.equal(await exists(out), false);
  } finally {
    await target.close();
    await redirecting.close();
    await rm(directory, { recursive: true, force: true });
  }
});
