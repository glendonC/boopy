import assert from 'node:assert/strict';
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { HandoffPreparation } from '../handoff-preparation.ts';
import { connectorApp } from '../http/connector.ts';
import { headsetApp } from '../http/headset.ts';
import { TaskStore } from '../interaction/tasks.ts';
import { startRequest, testBoopy } from '../testing.ts';
import { connectTask, goalTask, pendingName, replyTask, requestTask } from './task.ts';

const TOKEN = 'synthetic-task-cli-token';

/** What an earlier run's call recorded on the Mac, through the same local route. */
async function recordEarlier(port: number, body: Record<string, string>) {
  const response = await fetch(`http://127.0.0.1:${port}/v1/local-tasks/requests`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200);
  return (await response.json()) as { file: string };
}

/** A running connector on loopback, a session whose task is open, and a private data folder. */
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'boopy-task-cli-'));
  const dataDir = join(directory, 'data');
  const output = join(directory, 'out');
  await mkdir(dataDir, { mode: 0o700 });
  await mkdir(output);
  await writeFile(join(dataDir, 'connector-token'), TOKEN, { mode: 0o600 });
  const test = testBoopy();
  const tasks = new TaskStore(test.journal);
  const connector = connectorApp(test.boopy, {
    token: TOKEN,
    baseUrl: 'http://127.0.0.1',
    logger: false,
    handoff: new HandoffPreparation({
      journal: test.journal,
      outputRoot: join(directory, 'handoffs'),
      dataDir,
      port: 0,
      packageForId: (id) => test.boopy.package(id),
      sessionForId: (id) => test.boopy.view(id),
      supersessions: () => test.boopy.supersessions,
    }),
    tasks,
    goal: tasks,
  });
  await connector.listen({ host: '127.0.0.1', port: 0 });
  const port = (connector.server.address() as AddressInfo).port;
  const headset = headsetApp(test.boopy, { logger: false, tasks });
  const capture = startRequest('What is this?');
  const session = await test.boopy.start({
    ...capture,
    frame: { ...capture.frame, source: 'current-surroundings', timestampTrusted: false },
    attention: {
      scope: 'target',
      evidence: 'visual',
      source: 'current-surroundings',
      ambiguousTarget: false,
      ocrRequested: false,
      segmentationRequested: false,
      maxAgeMs: 15000,
    },
  });
  const opened = await headset.inject({
    method: 'POST',
    url: `/v1/sessions/${session.id}/task`,
    headers: { host: '127.0.0.1', 'content-type': 'application/json' },
    payload: { eventId: 'evt_open', taskId: 'tsk_cli' },
  });
  assert.equal(opened.statusCode, 200, opened.body);
  return {
    ...test,
    directory,
    output,
    tasks,
    port,
    connection: { dataDir, port },
    async close() {
      connector.server.closeAllConnections();
      await connector.close();
      await headset.close();
      test.journal.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

describe('pnpm task', () => {
  it('names a connection, writes a private request file, and takes the reply file back', async () => {
    const ctx = await setup();
    try {
      const named = await connectTask({ ...ctx.connection, label: 'My study chat' });
      assert.match(named.connectionId, /^con_[a-f0-9]{32}$/);
      assert.match(named.message, /My study chat/);
      const requested = await requestTask({
        ...ctx.connection,
        taskId: 'tsk_cli',
        connectionId: named.connectionId,
        outDir: ctx.output,
      });
      const path = join(ctx.output, requested.fileName);
      assert.equal((await stat(path)).mode & 0o777, 0o600);
      const body = JSON.parse(await readFile(path, 'utf8'));
      assert.equal(body.type, 'boopy.task-request');
      assert.match(requested.message, /Boopy did not send it/);
      assert.equal(requested.message.includes(body.respondWith.nonce), false);
      const reply = join(ctx.directory, 'reply.json');
      const filled = { ...body.respondWith.components[0], text: 'A photo of a desert.' };
      await writeFile(reply, JSON.stringify({ ...body.respondWith, components: [filled] }));
      const answered = await replyTask({ ...ctx.connection, file: reply });
      assert.equal(answered.revision, 2);
      assert.match(answered.message, /My study chat/);
      assert.match(answered.message, /proposal/);
    } finally {
      await ctx.close();
    }
  });

  it('asks for nothing when the folder cannot take the file', async () => {
    const ctx = await setup();
    try {
      const { connectionId } = await connectTask({ ...ctx.connection, label: 'Study' });
      await assert.rejects(
        requestTask({
          ...ctx.connection,
          taskId: 'tsk_cli',
          connectionId,
          outDir: join(ctx.directory, 'missing'),
        }),
        /folder/,
      );
      assert.equal(
        ctx.journal.all().some((event) => event.type === 'task.request-prepared'),
        false,
      );
    } finally {
      await ctx.close();
    }
  });

  it('refuses a folder that is a symbolic link, asking for nothing', async () => {
    const ctx = await setup();
    try {
      const { connectionId } = await connectTask({ ...ctx.connection, label: 'Study' });
      const link = join(ctx.directory, 'linked-out');
      await symlink(ctx.output, link);
      await assert.rejects(
        requestTask({ ...ctx.connection, taskId: 'tsk_cli', connectionId, outDir: link }),
        /folder/,
      );
      assert.equal(
        ctx.journal.all().some((event) => event.type === 'task.request-prepared'),
        false,
      );
    } finally {
      await ctx.close();
    }
  });

  it('keeps its ids only until the request file is written', async () => {
    const ctx = await setup();
    try {
      const { connectionId } = await connectTask({ ...ctx.connection, label: 'Study' });
      const done = await requestTask({
        ...ctx.connection,
        taskId: 'tsk_cli',
        connectionId,
        outDir: ctx.output,
      });
      assert.deepEqual(await readdir(ctx.output), [done.fileName]);
    } finally {
      await ctx.close();
    }
  });

  it('writes the same request file again after a run that stopped before writing it', async () => {
    const ctx = await setup();
    try {
      const { connectionId } = await connectTask({ ...ctx.connection, label: 'Study' });
      // The earlier run kept its ids and the Mac recorded its request, then it stopped.
      const ids = { eventId: 'evt_lost', requestId: 'trq_lost', nonce: 'c'.repeat(32) };
      const pending = join(ctx.output, pendingName('tsk_cli', connectionId));
      await writeFile(pending, JSON.stringify(ids), { mode: 0o600 });
      const recorded = await recordEarlier(ctx.port, { ...ids, taskId: 'tsk_cli', connectionId });
      const again = await requestTask({
        ...ctx.connection,
        taskId: 'tsk_cli',
        connectionId,
        outDir: ctx.output,
      });
      assert.equal(again.requestId, 'trq_lost');
      assert.equal(await readFile(join(ctx.output, again.fileName), 'utf8'), recorded.file);
      assert.deepEqual(await readdir(ctx.output), [again.fileName]);
      assert.equal(
        ctx.journal.all().filter((event) => event.type === 'task.request-prepared').length,
        1,
      );
    } finally {
      await ctx.close();
    }
  });

  it('names the stopped request and the way on when its task has moved on', async () => {
    const ctx = await setup();
    try {
      const { connectionId } = await connectTask({ ...ctx.connection, label: 'Study' });
      const ids = { eventId: 'evt_lost', requestId: 'trq_lost', nonce: 'c'.repeat(32) };
      await writeFile(join(ctx.output, pendingName('tsk_cli', connectionId)), JSON.stringify(ids), {
        mode: 0o600,
      });
      const sessionId = ctx.journal.all()[0]?.session ?? '';
      await recordEarlier(ctx.port, { ...ids, taskId: 'tsk_cli', connectionId });
      ctx.tasks.act(
        {
          eventId: 'evt_retry',
          sessionId,
          taskId: 'tsk_cli',
          expectedRevision: 1,
          action: { type: 'retry' },
        },
        new Date().toISOString(),
      );
      await assert.rejects(
        requestTask({ ...ctx.connection, taskId: 'tsk_cli', connectionId, outDir: ctx.output }),
        /trq_lost.*Run this command again/s,
      );
      assert.deepEqual(await readdir(ctx.output), []);
    } finally {
      await ctx.close();
    }
  });

  it('refuses a task or connection id that is not one, before any file name is built', async () => {
    const ctx = await setup();
    try {
      const { connectionId } = await connectTask({ ...ctx.connection, label: 'Study' });
      const before = await readdir(ctx.directory);
      for (const [taskId, connection] of [
        ['tsk_a/../x', connectionId],
        ['tsk_cli', 'con_x/../y'],
      ] as const)
        await assert.rejects(
          requestTask({ ...ctx.connection, taskId, connectionId: connection, outDir: ctx.output }),
          /Nothing was requested/,
        );
      assert.deepEqual(await readdir(ctx.directory), before);
      assert.deepEqual(await readdir(ctx.output), []);
    } finally {
      await ctx.close();
    }
  });

  it('says the request file is already there only when it is whole, and rewrites one cut short', async () => {
    const ctx = await setup();
    try {
      const { connectionId } = await connectTask({ ...ctx.connection, label: 'Study' });
      const ids = { eventId: 'evt_done', requestId: 'trq_done', nonce: 'd'.repeat(32) };
      const pending = join(ctx.output, pendingName('tsk_cli', connectionId));
      const final = join(ctx.output, 'boopy-request-trq_done.json');
      const { file } = await recordEarlier(ctx.port, { ...ids, taskId: 'tsk_cli', connectionId });
      const run = () =>
        requestTask({ ...ctx.connection, taskId: 'tsk_cli', connectionId, outDir: ctx.output });
      await writeFile(pending, JSON.stringify(ids), { mode: 0o600 });
      await writeFile(final, file, { mode: 0o600 });
      assert.match((await run()).message, /already/);
      assert.deepEqual(await readdir(ctx.output), ['boopy-request-trq_done.json']);
      await writeFile(pending, JSON.stringify(ids), { mode: 0o600 });
      await writeFile(final, file.slice(0, 40), { mode: 0o600 });
      assert.match((await run()).message, /cut short/);
      assert.equal(await readFile(final, 'utf8'), file);
      assert.equal((await stat(final)).mode & 0o777, 0o600);
      assert.deepEqual(await readdir(ctx.output), ['boopy-request-trq_done.json']);
      assert.equal(
        ctx.journal.all().filter((event) => event.type === 'task.request-prepared').length,
        1,
      );
    } finally {
      await ctx.close();
    }
  });

  it('replaces a link left at the request file name without following it', async () => {
    const ctx = await setup();
    try {
      const { connectionId } = await connectTask({ ...ctx.connection, label: 'Study' });
      const ids = { eventId: 'evt_link', requestId: 'trq_link', nonce: 'e'.repeat(32) };
      await recordEarlier(ctx.port, { ...ids, taskId: 'tsk_cli', connectionId });
      await writeFile(join(ctx.output, pendingName('tsk_cli', connectionId)), JSON.stringify(ids), {
        mode: 0o600,
      });
      const outside = join(ctx.directory, 'outside.json');
      await writeFile(outside, 'untouched');
      await symlink(outside, join(ctx.output, 'boopy-request-trq_link.json'));
      await requestTask({ ...ctx.connection, taskId: 'tsk_cli', connectionId, outDir: ctx.output });
      assert.equal(await readFile(outside, 'utf8'), 'untouched');
      const info = await lstat(join(ctx.output, 'boopy-request-trq_link.json'));
      assert.equal(info.isFile(), true);
    } finally {
      await ctx.close();
    }
  });

  it('reads only a regular reply file of at most 16 KiB, never through a link', async () => {
    const ctx = await setup();
    try {
      const large = join(ctx.directory, 'large.json');
      await writeFile(large, JSON.stringify({ text: 'x'.repeat(16 * 1024) }));
      await assert.rejects(replyTask({ ...ctx.connection, file: large }), /16 KiB/);
      const target = join(ctx.directory, 'target.json');
      await writeFile(target, '{}');
      const link = join(ctx.directory, 'link.json');
      await symlink(target, link);
      await assert.rejects(replyTask({ ...ctx.connection, file: link }), /regular/);
    } finally {
      await ctx.close();
    }
  });
});

describe('pnpm task goal', () => {
  it('sets the language the person practises as their own journaled goal, and turns it off', async () => {
    const ctx = await setup();
    try {
      const on = await goalTask({ ...ctx.connection, language: 'ko', personLanguage: 'en' });
      assert.match(on.message, /Korean words, around English/);
      assert.deepEqual(
        { language: ctx.tasks.goal()?.language, personLanguage: ctx.tasks.goal()?.personLanguage },
        { language: 'ko', personLanguage: 'en' },
      );
      const set = ctx.journal.all().find((event) => event.type === 'goal.set');
      assert.equal(set?.actor, 'person');
      const off = await goalTask({ ...ctx.connection, language: null, personLanguage: 'en' });
      assert.equal(off.goal, null);
      assert.equal(ctx.tasks.goal(), null);
      await assert.rejects(
        goalTask({ ...ctx.connection, language: 'Korean', personLanguage: 'en' }),
      );
    } finally {
      await ctx.close();
    }
  });
});
