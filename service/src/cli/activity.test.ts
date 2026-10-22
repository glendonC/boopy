import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { constants } from 'node:fs';
import {
  chmod,
  type FileHandle,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Readable } from 'node:stream';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ActivityStore } from '../activity.ts';
import { ActivityRequestFile, ActivitySubmissionFile, sha256 } from '../activity-contract.ts';
import { HandoffPreparation } from '../handoff-preparation.ts';
import { connectorApp } from '../http/connector.ts';
import { startRequest, testBoopy } from '../testing.ts';
import {
  askActivity,
  exportSubmission,
  importActivity,
  importReply,
  requestActivity,
} from './activity.ts';

it('asks once and polls the same call without writing any output files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'boopy-ask-cli-'));
  await writeFile(join(directory, 'connector-token'), TOKEN, { mode: 0o600 });
  const requests: { method: string | undefined; url: string | undefined }[] = [];
  const base = {
    callId: 'cal_synthetic',
    kind: 'activity',
    provider: 'ollama',
    model: 'qwen3.6:35b-a3b-nvfp4',
    askedAt: '1970-01-01T12:00:00Z',
    finishedAt: null,
    durationMs: null,
    packageId: 'ctx_synthetic',
    requestId: 'arq_synthetic',
    submissionId: null,
    activityId: null,
    replyId: null,
    nextActivityId: null,
    failure: null,
    issues: [],
  };
  let outcome = 'imported';
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url });
    request.resume();
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify(
        request.method === 'POST'
          ? { ...base, state: 'running' }
          : {
              ...base,
              state: outcome,
              finishedAt: '1970-01-01T12:00:01Z',
              durationMs: 1000,
              activityId: outcome === 'imported' ? 'act_synthetic' : null,
              failure:
                outcome === 'failed'
                  ? {
                      code: 'assistant_error',
                      message:
                        "Boopy couldn't make practice from this: the local model reported an error.",
                    }
                  : null,
            },
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const options = {
      dataDir: directory,
      port,
      packageId: 'ctx_synthetic',
      goal: 'Synthetic practice.',
    };
    const success = await askActivity(options);
    assert.equal(success.exitCode, 0);
    assert.equal(success.message, 'Practice ready in Boopy: act_synthetic');
    assert.deepEqual(requests.slice(0, 2), [
      { method: 'POST', url: '/v1/local-activities/practice-requests' },
      { method: 'GET', url: '/v1/local-activities/calls/cal_synthetic' },
    ]);
    outcome = 'failed';
    const failure = await askActivity(options);
    assert.equal(failure.exitCode, 1);
    assert.match(failure.message, /local model reported an error/);
    assert.deepEqual(await readdir(directory), ['connector-token']);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

const TOKEN = 'synthetic-activity-cli-token';
const CLI = join(dirname(fileURLToPath(import.meta.url)), 'activity.ts');

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'boopy-activity-cli-'));
  const dataDir = join(directory, 'data');
  const output = join(directory, 'out');
  await mkdir(dataDir, { mode: 0o700 });
  await mkdir(output, { mode: 0o700 });
  await writeFile(join(dataDir, 'connector-token'), TOKEN, { mode: 0o600 });
  const test = testBoopy();
  const session = await test.boopy.start(startRequest('Synthetic camel and tent.'));
  const packageId = test.boopy.commit(session.id).committed?.packageId;
  assert.ok(packageId);
  let port = 0;
  const preparation = new HandoffPreparation({
    journal: test.journal,
    outputRoot: join(dataDir, 'handoffs'),
    dataDir,
    get port() {
      return port;
    },
    packageForId: (id) => test.boopy.package(id),
    sessionForId: (id) => test.boopy.view(id),
    supersessions: () => test.boopy.supersessions,
  });
  const ids = new Map<string, number>();
  const store = new ActivityStore({
    journal: test.journal,
    preparation,
    packageForId: (id) => test.boopy.package(id),
    supersessions: () => test.boopy.supersessions,
    newId: (prefix) => {
      const next = (ids.get(prefix) ?? 0) + 1;
      ids.set(prefix, next);
      return `${prefix}_k${next}`;
    },
  });
  const app = connectorApp(test.boopy, {
    token: TOKEN,
    baseUrl: 'http://127.0.0.1',
    logger: false,
    handoff: preparation,
    activities: store,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  port = (app.server.address() as AddressInfo).port;
  await preparation.prepare(session.id, { requestId: 'synthetic-preparation-1', packageId });
  return {
    ...test,
    directory,
    dataDir,
    output,
    packageId,
    store,
    port,
    events: () => test.journal.all().length,
    async close() {
      app.server.closeAllConnections();
      await app.close();
      test.journal.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

type Setup = Awaited<ReturnType<typeof setup>>;

function activityFile(request: ReturnType<typeof ActivityRequestFile.parse>) {
  return JSON.stringify({
    ...request.respondWith,
    author: 'Grok Bot',
    fallbackText: 'Think of a fair daytime petit taxi fare in dirhams.',
    activity: {
      title: 'Petit taxi fare',
      purpose: 'Check your sense of a fair petit taxi fare before you ride.',
      instruction: { text: 'What would you expect to pay?', language: 'en' },
      components: [
        {
          type: 'arrange',
          axis: { kind: 'number', min: 0, max: 200, step: 5, unit: 'MAD' },
          tokens: [{ key: 'a', label: { text: 'My estimate', language: 'en' }, sourceId: null }],
        },
      ],
      hints: [{ text: 'Think about the distance and the time of day.', language: 'en' }],
    },
  });
}

async function requested(test: Setup) {
  const result = await requestActivity({
    packageId: test.packageId,
    goal: 'Understand fair taxi fares in Marrakech.',
    outDir: test.output,
    dataDir: test.dataDir,
    port: test.port,
  });
  const file = await readFile(join(test.output, result.fileName), 'utf8');
  return { result, request: ActivityRequestFile.parse(JSON.parse(file)) };
}

/** A submission ready to export: requested, imported, arranged and submitted. */
async function submitted(test: Setup) {
  const { request } = await requested(test);
  const input = join(test.directory, 'activity.json');
  await writeFile(input, activityFile(request));
  await importActivity({ file: input, dataDir: test.dataDir, port: test.port });
  test.store.arrange('act_k1', { revision: 0, positions: { a: 0.5 } });
  const submissionId = test.store.submit('act_k1', { revision: 1 }).submissions[0]?.submissionId;
  assert.ok(submissionId);
  return submissionId;
}

const exportEvents = (test: Setup) =>
  test.journal.all().filter((event) => event.type === 'activity.submission-exported').length;

/** A stand-in connector that takes each request and never answers it. */
async function silentConnector() {
  let asked = () => {};
  const arrived = new Promise<void>((resolve) => {
    asked = resolve;
  });
  const server = createServer(() => asked());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    port: (server.address() as AddressInfo).port,
    arrived,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** Runs node with the arguments and stops it with the signal once `ready` resolves. */
async function stoppedCommand(
  args: string[],
  signal: 'SIGINT' | 'SIGTERM',
  ready: (stdout: Readable) => Promise<void>,
) {
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    let printed = '';
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      printed += chunk;
    });
    child.stdout.resume();
    // Close, unlike exit, waits until everything the command printed has been read.
    const closed = once(child, 'close');
    await ready(child.stdout);
    child.kill(signal);
    const [code, killedBy] = await closed;
    return { code, killedBy, printed };
  } finally {
    child.kill('SIGKILL');
  }
}

/**
 * Runs the command against a connector that never answers, lets `asking` look around once the
 * command has asked it, then stops the command with the signal.
 */
async function stoppedWhileAsking(
  args: string[],
  signal: 'SIGINT' | 'SIGTERM',
  asking: () => Promise<void>,
) {
  const silent = await silentConnector();
  try {
    return await stoppedCommand([CLI, ...args, '--port', String(silent.port)], signal, async () => {
      await silent.arrived;
      await asking();
    });
  } finally {
    await silent.close();
  }
}

/**
 * Loaded into the command's own process: every file write puts its first 16 bytes on disk, says
 * "writing" on stdout and then waits a minute, so a stop lands while the write is unfinished.
 */
const STALL_WRITES = `import { open } from 'node:fs/promises';
const probe = await open(process.execPath, 'r');
const handles = Object.getPrototypeOf(probe);
await probe.close();
const writeFileAsUsual = handles.writeFile;
handles.writeFile = async function (content, options) {
  await writeFileAsUsual.call(this, content.slice(0, 16), options);
  process.stdout.write('writing');
  await new Promise((resolve) => setTimeout(resolve, 60000));
};
`;

/**
 * Until the returned function is called, every file write in this process goes through `write`,
 * which can still write as usual.
 */
async function patchWrites(
  directory: string,
  write: (asUsual: (content: string) => Promise<void>, content: string) => Promise<void>,
) {
  const probe = await open(join(directory, 'probe'), 'w');
  const handles = Object.getPrototypeOf(probe);
  await probe.close();
  const writeFileAsUsual = handles.writeFile;
  handles.writeFile = async function (this: FileHandle, content: string) {
    await write((text) => writeFileAsUsual.call(this, text, 'utf8'), content);
  };
  return () => {
    handles.writeFile = writeFileAsUsual;
  };
}

/**
 * Until the returned function is called, every file write in this process puts its first 16 bytes
 * on disk, lets `meanwhile` run, and then fails, as on a full disk.
 */
const failWrites = (directory: string, meanwhile = async () => {}) =>
  patchWrites(directory, async (asUsual, content) => {
    await asUsual(content.slice(0, 16));
    await meanwhile();
    throw Object.assign(new Error('synthetic full disk'), { code: 'ENOSPC' });
  });

function clean(test: Setup, printed: string) {
  assert.equal(printed.includes(TOKEN), false);
  assert.equal(printed.includes(test.directory), false);
  assert.equal(printed.includes('Nothing has been sent to Muse'), false);
}

describe('pnpm activity', () => {
  it('runs request, import, export and reply against the local connector', async () => {
    const test = await setup();
    try {
      const { result, request } = await requested(test);
      assert.equal(result.fileName, 'boopy-activity-request-arq_k1.json');
      const written = await readFile(join(test.output, result.fileName));
      assert.equal(sha256(written), result.fileSha256);
      assert.equal((await stat(join(test.output, result.fileName))).mode & 0o777, 0o600);
      assert.match(result.message, /boopy-activity-request-arq_k1\.json/);
      assert.match(result.message, /Boopy did not send it/);
      assert.match(result.message, /exactly one downloadable \.json file/);
      clean(test, result.message);
      assert.deepEqual(await readdir(test.output), [result.fileName]);

      const input = join(test.directory, 'activity.json');
      const content = `\u{FEFF}${activityFile(request)}`;
      await writeFile(input, content);
      const imported = await importActivity({
        file: input,
        dataDir: test.dataDir,
        port: test.port,
      });
      assert.equal(imported.activityId, 'act_k1');
      assert.equal(imported.status, 'active');
      assert.match(imported.message, /act_k1/);
      clean(test, imported.message);
      const view = test.store.view('act_k1');
      assert.equal(view.provenance.artifactSha256, sha256(await readFile(input)));
      const again = await importActivity({ file: input, dataDir: test.dataDir, port: test.port });
      assert.equal(again.duplicate, true);
      assert.match(again.message, /before/);

      test.store.arrange('act_k1', { revision: 0, positions: { a: 0.25 } });
      const submitted = test.store.submit('act_k1', { revision: 1 });
      const submissionId = submitted.submissions[0]?.submissionId ?? '';
      const exported = await exportSubmission({
        submissionId,
        outDir: test.output,
        dataDir: test.dataDir,
        port: test.port,
      });
      assert.equal(exported.fileName, `boopy-activity-submission-${submissionId}.json`);
      const submissionPath = join(test.output, exported.fileName);
      assert.equal((await stat(submissionPath)).mode & 0o777, 0o600);
      const submission = ActivitySubmissionFile.parse(
        JSON.parse(await readFile(submissionPath, 'utf8')),
      );
      assert.equal(submission.digest, 'arrange: My estimate = 50 MAD | hints: 0 of 1');
      assert.match(exported.message, /copy its echo exactly/);
      clean(test, exported.message);

      const replyPath = join(test.directory, 'reply.json');
      await writeFile(
        replyPath,
        `Here is the reply.\n\n\`\`\`json\n${JSON.stringify({
          ...submission.respondWith,
          author: 'Grok Bot',
          reply: {
            summary: { text: 'Synthetic example reply for rendering tests.', language: 'en' },
            points: [
              { about: 'arrange', text: 'Synthetic point about the estimate.', language: 'en' },
            ],
          },
          next: null,
        })}\n\`\`\`\n`,
      );
      const reply = await importReply({ file: replyPath, dataDir: test.dataDir, port: test.port });
      assert.equal(reply.replyId, 'rep_k1');
      assert.equal(reply.nextActivityId, null);
      assert.match(reply.message, /rep_k1/);
      assert.match(reply.message, /not verified/);
      clean(test, reply.message);
    } finally {
      await test.close();
    }
  });

  it('writes outputs only as new private files, whatever the umask', async () => {
    const test = await setup();
    const previous = process.umask();
    try {
      for (const mask of [0o000, 0o077]) {
        process.umask(mask);
        const outDir = join(test.directory, `umask-${mask}`);
        await mkdir(outDir);
        const result = await requestActivity({
          packageId: test.packageId,
          goal: 'Practice.',
          outDir,
          dataDir: test.dataDir,
          port: test.port,
        });
        assert.equal((await stat(join(outDir, result.fileName))).mode & 0o777, 0o600);
        assert.deepEqual(await readdir(outDir), [result.fileName]);
      }
    } finally {
      process.umask(previous);
      await test.close();
    }
  });

  it('refuses an existing output or a dangling symlink and never overwrites', async () => {
    const test = await setup();
    try {
      const { request } = await requested(test);
      const input = join(test.directory, 'activity.json');
      await writeFile(input, activityFile(request));
      await importActivity({ file: input, dataDir: test.dataDir, port: test.port });
      test.store.arrange('act_k1', { revision: 0, positions: { a: 0.5 } });
      const submissionId =
        test.store.submit('act_k1', { revision: 1 }).submissions[0]?.submissionId ?? '';
      const name = `boopy-activity-submission-${submissionId}.json`;
      await writeFile(join(test.output, name), 'existing synthetic bytes');
      const before = test.events();
      await assert.rejects(
        exportSubmission({
          submissionId,
          outDir: test.output,
          dataDir: test.dataDir,
          port: test.port,
        }),
        /never overwritten/,
      );
      assert.equal(await readFile(join(test.output, name), 'utf8'), 'existing synthetic bytes');
      const linked = join(test.directory, 'linked');
      await mkdir(linked);
      await symlink(join(test.directory, 'missing-target'), join(linked, name));
      await assert.rejects(
        exportSubmission({ submissionId, outDir: linked, dataDir: test.dataDir, port: test.port }),
        /never overwritten/,
      );
      await assert.rejects(readFile(join(test.directory, 'missing-target')));
      // The export file is claimed before the service is asked, so a refusal records nothing.
      assert.equal(test.events(), before);
      assert.deepEqual(await readdir(test.output), [`boopy-activity-request-arq_k1.json`, name]);
      const fresh = join(test.directory, 'fresh');
      await mkdir(fresh);
      const exported = await exportSubmission({
        submissionId,
        outDir: fresh,
        dataDir: test.dataDir,
        port: test.port,
      });
      assert.deepEqual(await readdir(fresh), [exported.fileName]);
    } finally {
      await test.close();
    }
  });

  it('removes a partly written export and points to the recorded bytes', async () => {
    const test = await setup();
    try {
      const submissionId = await submitted(test);
      const name = `boopy-activity-submission-${submissionId}.json`;
      const full = join(test.directory, 'full');
      await mkdir(full);
      const restore = await failWrites(test.directory);
      try {
        await assert.rejects(
          exportSubmission({ submissionId, outDir: full, dataDir: test.dataDir, port: test.port }),
          (error: Error) => {
            assert.equal(
              error.message,
              `Could not finish writing ${name}, so it was removed. Boopy has recorded this export; exporting it into another folder gives exactly the recorded bytes.`,
            );
            clean(test, error.message);
            return true;
          },
        );
      } finally {
        restore();
      }
      assert.deepEqual(await readdir(full), []);
      assert.equal(exportEvents(test), 1);
      const recorded = test.store.view('act_k1').submissions[0]?.export?.fileSha256;
      const other = join(test.directory, 'other');
      await mkdir(other);
      const exported = await exportSubmission({
        submissionId,
        outDir: other,
        dataDir: test.dataDir,
        port: test.port,
      });
      assert.equal(exported.fileSha256, recorded);
      assert.equal(sha256(await readFile(join(other, name))), recorded);
      assert.equal(exportEvents(test), 1);
    } finally {
      await test.close();
    }
  });

  it('removes a partly written request file and its probe, and a new request works', async () => {
    const test = await setup();
    try {
      const full = join(test.directory, 'full');
      await mkdir(full);
      const ask = () =>
        requestActivity({
          packageId: test.packageId,
          goal: 'Synthetic goal.',
          outDir: full,
          dataDir: test.dataDir,
          port: test.port,
        });
      const restore = await failWrites(test.directory);
      try {
        await assert.rejects(ask(), (error: Error) => {
          assert.equal(
            error.message,
            'Could not finish writing boopy-activity-request-arq_k1.json, so it was removed.',
          );
          clean(test, error.message);
          return true;
        });
      } finally {
        restore();
      }
      assert.deepEqual(await readdir(full), []);
      const again = await ask();
      assert.equal(again.fileName, 'boopy-activity-request-arq_k2.json');
      assert.deepEqual(await readdir(full), [again.fileName]);
    } finally {
      await test.close();
    }
  });

  it('keeps a file another process put at the name and never says it was removed', async () => {
    const test = await setup();
    try {
      const submissionId = await submitted(test);
      const outDir = join(test.directory, 'replaced');
      await mkdir(outDir);
      const exported = `boopy-activity-submission-${submissionId}.json`;
      const requested = 'boopy-activity-request-arq_k2.json';
      const replace = (name: string) => async () => {
        await rm(join(outDir, name));
        await writeFile(join(outDir, name), 'written by another process');
      };
      for (const [name, run, message] of [
        [
          exported,
          () => exportSubmission({ submissionId, outDir, dataDir: test.dataDir, port: test.port }),
          `Could not finish writing ${exported}, and ${exported} is no longer the file Boopy wrote. Boopy has recorded this export; exporting it into another folder gives exactly the recorded bytes.`,
        ],
        [
          requested,
          () =>
            requestActivity({
              packageId: test.packageId,
              goal: 'Synthetic goal.',
              outDir,
              dataDir: test.dataDir,
              port: test.port,
            }),
          `Could not finish writing ${requested}, and ${requested} is no longer the file Boopy wrote.`,
        ],
      ] as const) {
        const restore = await failWrites(test.directory, replace(name));
        try {
          await assert.rejects(run(), (error: Error) => {
            assert.equal(error.message, message);
            return true;
          });
        } finally {
          restore();
        }
        assert.equal(await readFile(join(outDir, name), 'utf8'), 'written by another process');
      }
      // Only the two files of the other process are left; the request's probe file is gone.
      assert.deepEqual((await readdir(outDir)).sort(), [requested, exported].sort());
    } finally {
      await test.close();
    }
  });

  it('never says it wrote a file whose name another program replaced or removed', async () => {
    const test = await setup();
    try {
      const submissionId = await submitted(test);
      const exported = `boopy-activity-submission-${submissionId}.json`;
      for (const [change, said, request] of [
        ['replaced', 'was replaced by another program while Boopy was writing it', 2],
        ['removed', 'is no longer the file Boopy wrote', 3],
      ] as const) {
        const outDir = join(test.directory, change);
        await mkdir(outDir);
        const requested = `boopy-activity-request-arq_k${request}.json`;
        for (const [name, run, advice] of [
          [
            exported,
            () =>
              exportSubmission({ submissionId, outDir, dataDir: test.dataDir, port: test.port }),
            'The export is recorded; export it again into another folder to get the recorded bytes.',
          ],
          [
            requested,
            () =>
              requestActivity({
                packageId: test.packageId,
                goal: 'Synthetic goal.',
                outDir,
                dataDir: test.dataDir,
                port: test.port,
              }),
            'Request again to get a new request file.',
          ],
        ] as const) {
          // Another program removes the name, and may put its own file there; Boopy's whole
          // write then lands in the file it created, which no longer has that name.
          const restore = await patchWrites(test.directory, async (asUsual, content) => {
            await rm(join(outDir, name));
            if (change === 'replaced')
              await writeFile(join(outDir, name), 'written by another program');
            await asUsual(content);
          });
          try {
            await assert.rejects(run(), (error: Error) => {
              assert.equal(error.message, `${name} ${said}. ${advice}`);
              clean(test, error.message);
              return true;
            });
          } finally {
            restore();
          }
        }
        assert.deepEqual(
          (await readdir(outDir)).sort(),
          change === 'replaced' ? [requested, exported].sort() : [],
        );
        if (change === 'replaced')
          assert.equal(
            await readFile(join(outDir, exported), 'utf8'),
            'written by another program',
          );
      }
      // The export is recorded, and exporting it into another folder gives the recorded bytes.
      const other = join(test.directory, 'other');
      await mkdir(other);
      const again = await exportSubmission({
        submissionId,
        outDir: other,
        dataDir: test.dataDir,
        port: test.port,
      });
      assert.equal(again.fileSha256, test.store.view('act_k1').submissions[0]?.export?.fileSha256);
      assert.equal(sha256(await readFile(join(other, exported))), again.fileSha256);
    } finally {
      await test.close();
    }
  });
});
