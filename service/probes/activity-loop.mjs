/**
 * Synthetic end-to-end run of the assistant activity loop on a real, isolated Boopy service.
 *
 *   node probes/activity-loop.mjs [--headset-port 47910] [--connector-port 47911] [--data-root DIR]
 *
 * It starts src/main.ts with the fixture interpreter and no other provider on two loopback ports
 * (never 47900 or 47901, and never ports already in use) and a new private data directory, then
 * drives the headset API and the pnpm activity command: request, import, arrangement, sequence,
 * hint, a refused stale submit, submit, export, a reply with a next activity, the next activity
 * and the same reply again. It then restarts the service on the same journal and requires
 * identical views and no appended events. All content is synthetic and nothing is sent anywhere.
 * It prints check names, identifiers and the digest, never file content, the token or a path; a
 * failed step is reported by name and exit code, with details in probe-error.log in the run's
 * private folder. SIGINT and SIGTERM stop the service it started. Importing it starts nothing.
 */
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, rmdir, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';

const SERVICE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RESERVED_PORTS = new Set([47900, 47901]);
const run = promisify(execFile);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
/** Stop functions of the services this process started, so a signal can stop them too. */
const running = new Set();

/** True when nothing listens on the loopback port. */
export function portFree(port) {
  return new Promise((done) => {
    const server = createServer();
    server.once('error', () => done(false));
    server.listen(port, '127.0.0.1', () => server.close(() => done(true)));
  });
}

/** Only what the service needs, so no provider setting or key from the caller's shell leaks in. */
function environment(dataDir, headsetPort, connectorPort) {
  return {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
    BOOPY_DATA_DIR: dataDir,
    BOOPY_PORT: String(headsetPort),
    BOOPY_CONNECTOR_PORT: String(connectorPort),
    BOOPY_INTERPRETER: 'fixture',
    BOOPY_SEGMENTER: 'none',
    BOOPY_SPEECH_OUTPUT: 'none',
    BOOPY_LIVE_SCENE: 'none',
    BOOPY_MEMORY: 'none',
    BOOPY_SEMANTIC_MEMORY: 'none',
    BOOPY_LOG: '0',
  };
}

/**
 * Whether a path is the real service's folder, ~/.boopy or the caller's BOOPY_DATA_DIR: by name,
 * or by device and inode whenever both exist, which also catches case variants on a
 * case-insensitive volume, the /System/Volumes/Data spelling and any other link to it.
 */
async function serviceFolder(path) {
  const folders = [resolve(homedir(), '.boopy')];
  if (process.env.BOOPY_DATA_DIR) folders.push(resolve(process.env.BOOPY_DATA_DIR));
  if (folders.includes(path)) return true;
  const here = await stat(path, { bigint: true }).catch(() => null);
  if (here === null) return false;
  for (const folder of folders) {
    const there = await stat(folder, { bigint: true }).catch(() => null);
    if (there !== null && there.dev === here.dev && there.ino === here.ino) return true;
  }
  return false;
}

/** Ours only: our child is alive, its journal is in our folder and its connector takes our token. */
async function ours(alive, dataDir, connectorPort) {
  if (!alive() || !existsSync(join(dataDir, 'journal.sqlite'))) return false;
  const token = (await readFile(join(dataDir, 'connector-token'), 'utf8').catch(() => '')).trim();
  if (!token) return false;
  // An unknown package is refused after authentication and discloses nothing.
  const response = await fetch(`http://127.0.0.1:${connectorPort}/v1/context/ctx_probe_identity`, {
    headers: { authorization: `Bearer ${token}` },
  });
  await response.body?.cancel();
  return response.status === 404 && alive();
}

async function startService(dataDir, headsetPort, connectorPort) {
  const log = await open(join(dataDir, 'service.log'), 'a', 0o600);
  const child = spawn(process.execPath, ['src/main.ts'], {
    cwd: SERVICE,
    env: environment(dataDir, headsetPort, connectorPort),
    stdio: ['ignore', log.fd, log.fd],
  });
  const exited = new Promise((done) => child.once('exit', done));
  const alive = () => child.exitCode === null && child.signalCode === null;
  const stop = async () => {
    if (alive()) child.kill('SIGTERM');
    await exited;
    running.delete(stop);
  };
  running.add(stop);
  await log.close();
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (!alive()) break;
    try {
      const response = await fetch(`http://127.0.0.1:${headsetPort}/v1/health`);
      await response.body?.cancel();
      if (response.ok && (await ours(alive, dataDir, connectorPort))) return stop;
    } catch {
      // Not listening yet.
    }
    await sleep(200);
  }
  await stop();
  throw new Error(
    'The isolated Boopy service did not start; see service.log in the data directory.',
  );
}

/**
 * Runs the loop and a restart against a fresh service. `dataDir` must be the absolute, already
 * resolved path of an existing, empty, private (0700) directory that is not a link and not the
 * real service's folder; the service writes its journal there and the files go to `files/`.
 */
export async function runActivityLoop({ dataDir, headsetPort, connectorPort, log = console.log }) {
  for (const port of [headsetPort, connectorPort])
    if (!Number.isInteger(port) || port < 1024 || port > 65535 || RESERVED_PORTS.has(port))
      throw new Error('Choose loopback ports from 1024 to 65535 other than 47900 and 47901.');
  if (headsetPort === connectorPort) throw new Error('Choose two different ports.');
  if (typeof dataDir !== 'string' || !isAbsolute(dataDir) || resolve(dataDir) !== dataDir)
    throw new Error(
      'Choose an absolute, already resolved data directory path, not a relative one.',
    );
  if (await serviceFolder(dataDir))
    throw new Error("Choose a data directory other than the Boopy service's own folder.");
  // lstat on a resolved path never follows a trailing slash into a linked folder.
  const info = await lstat(dataDir).catch(() => null);
  if (!info?.isDirectory() || (info.mode & 0o777) !== 0o700)
    throw new Error('Choose a private 0700 data directory that is not a link.');
  if ((await readdir(dataDir)).length > 0)
    throw new Error('Choose an empty data directory; earlier evidence is never reused.');
  for (const port of [headsetPort, connectorPort])
    if (!(await portFree(port))) throw new Error(`Port ${port} is in use; nothing was started.`);

  const files = join(dataDir, 'files');
  await mkdir(files, { mode: 0o700 });
  const headsetUrl = `http://127.0.0.1:${headsetPort}`;
  const env = environment(dataDir, headsetPort, connectorPort);
  const checks = [];
  const check = (name) => {
    checks.push(name);
    log(`ok - ${name}`);
  };
  const headset = async (method, path, body) => {
    const response = await fetch(`${headsetUrl}${path}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json = await response.json();
    if (!response.ok)
      throw new Error(`${method} ${path} gave ${response.status} ${json.error?.code}`);
    return json;
  };
  let step = 'service start';
  const cli = async (...args) => {
    const { stdout } = await run(
      process.execPath,
      ['src/cli/activity.ts', ...args, '--data-dir', dataDir, '--port', String(connectorPort)],
      { cwd: SERVICE, env },
    );
    return stdout.trim();
  };
  const journalCounts = () => {
    const db = new DatabaseSync(join(dataDir, 'journal.sqlite'), { readOnly: true });
    try {
      return {
        events: db.prepare('SELECT count(*) AS n FROM events').get().n,
        activityEvents: db
          .prepare("SELECT count(*) AS n FROM events WHERE type LIKE 'activity.%'")
          .get().n,
      };
    } finally {
      db.close();
    }
  };
  const snapshot = async (ids) => ({
    list: await headset('GET', '/v1/activities'),
    views: Object.fromEntries(
      await Promise.all(ids.map(async (id) => [id, await headset('GET', `/v1/activities/${id}`)])),
    ),
  });

  let stop = await startService(dataDir, headsetPort, connectorPort);
  try {
    step = 'health';
    const health = await headset('GET', '/v1/health');
    assert.equal(health.activities, true);
    check('headset health carries activities: true');

    step = 'session';
    const jpeg = (await readFile(join(SERVICE, 'fixtures', 'images', 'desert-photo.jpg'))).toString(
      'base64',
    );
    const session = await headset('POST', '/v1/sessions', {
      frame: { jpeg, width: 1280, height: 960, capturedAt: new Date().toISOString() },
      cues: { gaze: { point: { x: 0.45, y: 0.55 }, onSurface: true } },
      speech: { text: 'Synthetic: I want to practice describing this camp in Korean.' },
      device: { model: 'synthetic', app: 'activity loop probe' },
    });
    const committed = await headset('POST', `/v1/sessions/${session.id}/commit`);
    const packageId = committed.committed.packageId;
    check(`synthetic session committed as ${packageId}`);

    step = 'preparation';
    const preparation = `/v1/sessions/${session.id}/handoff-preparations`;
    await headset('POST', preparation, { requestId: 'loop-preparation-1', packageId });
    for (let attempt = 0; ; attempt += 1) {
      const status = await headset('GET', `${preparation}/loop-preparation-1`);
      if (status.state === 'prepared-local') break;
      if (status.state === 'failed' || attempt > 150)
        throw new Error(`Preparation ${status.state}.`);
      await sleep(200);
    }
    check('local handoff prepared');

    step = 'request';
    const requested = await cli(
      'request',
      '--package',
      packageId,
      '--goal',
      'Practice saying where things are in Korean, using my desert camp.',
      '--out-dir',
      files,
    );
    const requestName = /Wrote (boopy-activity-request-arq_[A-Za-z0-9_-]+\.json)/.exec(
      requested,
    )?.[1];
    assert.ok(requestName, 'The request command names its file.');
    assert.equal(requested.includes(dataDir), false);
    const requestPath = join(files, requestName);
    assert.equal((await stat(requestPath)).mode & 0o777, 0o600);
    const request = JSON.parse(await readFile(requestPath, 'utf8'));
    assert.equal(request.delivery, 'not-sent-by-boopy');
    assert.ok(request.context.packet.length > 0);
    check(`request file ${requestName} written 0600, not sent`);

    step = 'import';
    const camel = request.sources.find((source) => source.label === 'Camels');
    assert.ok(camel, 'The fixture interpreter proposes Camels.');
    const activityPath = join(files, 'synthetic-activity.json');
    await writeFile(
      activityPath,
      JSON.stringify(
        {
          ...request.respondWith,
          author: 'Grok Bot',
          fallbackText: 'Picture the camel to the left of the tent and say it in Korean.',
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
                  {
                    key: 'a',
                    label: { text: '낙타', language: 'ko', gloss: 'camel' },
                    sourceId: camel.sourceId,
                  },
                  {
                    key: 'b',
                    label: { text: '텐트', language: 'ko', gloss: 'tent' },
                    sourceId: null,
                  },
                ],
                target: { subject: 'a', relation: 'left-of', object: 'b' },
              },
              {
                type: 'sequence',
                joiner: 'space',
                language: 'ko',
                tiles: [
                  { key: 't1', text: '있어요' },
                  { key: 't2', text: '낙타가' },
                  { key: 't3', text: '왼쪽에' },
                  { key: 't4', text: '텐트' },
                  { key: 't5', text: '오른쪽에' },
                ],
              },
            ],
            hints: [
              { text: 'Start with the camel, then say where it is.', language: 'en' },
              { text: 'The place word comes right before 있어요.', language: 'en' },
            ],
          },
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    const imported = await cli('import', '--file', activityPath);
    const activityId = /Imported (act_[A-Za-z0-9_-]+) as an active activity/.exec(imported)?.[1];
    assert.ok(activityId, 'The import command names an active activity.');
    check(`activity imported as ${activityId} (active)`);

    step = 'headset view';
    const listed = await headset('GET', '/v1/activities');
    assert.ok(listed.activities.some((entry) => entry.activityId === activityId));
    let view = await headset('GET', `/v1/activities/${activityId}`);
    assert.equal(view.revision, 0);
    assert.equal(view.components[0].tokens[0].source.label, 'Camels');
    check('headset lists and opens it at revision 0 with its source');

    step = 'arrangement';
    view = await headset('POST', `/v1/activities/${activityId}/arrangement`, {
      revision: 0,
      positions: { a: 0.22, b: 0.71 },
    });
    assert.equal(view.components[0].derived.relation, 'left-of');
    assert.equal(view.components[0].derived.matchesTarget, true);
    check('arrangement recorded: camel left of tent, matching the target');

    step = 'sequence';
    const keyOf = (text) => view.components[1].tiles.find((tile) => tile.text === text).key;
    const chosen = ['낙타가', '텐트', '왼쪽에', '있어요'].map(keyOf);
    view = await headset('POST', `/v1/activities/${activityId}/sequence`, { revision: 1, chosen });
    assert.equal(view.components[1].text, '낙타가 텐트 왼쪽에 있어요');
    check('sequence recorded');

    step = 'hint';
    view = await headset('POST', `/v1/activities/${activityId}/hints`, { revision: 2 });
    assert.equal(view.hints.revealed.length, 1);
    check('first hint revealed');

    step = 'stale submit';
    const stale = await fetch(`${headsetUrl}/v1/activities/${activityId}/submissions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ revision: 2 }),
    });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).error.code, 'stale_activity');
    check('a stale submission is refused with 409 stale_activity');

    step = 'submit';
    view = await headset('POST', `/v1/activities/${activityId}/submissions`, { revision: 3 });
    const submission = view.submissions[0];
    assert.equal(submission.revision, 4);
    assert.equal(submission.export, null);
    check(`submitted ${submission.submissionId}`);

    step = 'export';
    const exported = await cli(
      'export',
      '--submission',
      submission.submissionId,
      '--out-dir',
      files,
    );
    const submissionName = /Wrote (boopy-activity-submission-sub_[A-Za-z0-9_-]+\.json)/.exec(
      exported,
    )?.[1];
    assert.ok(submissionName, 'The export command names its file.');
    const submissionFile = JSON.parse(await readFile(join(files, submissionName), 'utf8'));
    assert.equal(submissionFile.digest, submission.digest);
    assert.equal(submissionFile.respondWith.echo, submission.digest);
    assert.deepEqual(submissionFile.boopyChecked.arrangementRelation, {
      subject: 'a',
      object: 'b',
      requested: 'left-of',
      arranged: 'left-of',
      matches: true,
    });
    view = await headset('GET', `/v1/activities/${activityId}`);
    assert.equal(view.submissions[0].export.state, 'exported-not-sent');
    check(`submission file ${submissionName} written; the view says exported, not sent`);

    step = 'reply';
    const replyPath = join(files, 'synthetic-reply.md');
    const replyFile = {
      ...submissionFile.respondWith,
      author: 'Grok Bot',
      reply: {
        summary: {
          text: 'Synthetic reply: the sentence and the arrangement agree.',
          language: 'en',
        },
        points: [
          { about: 'sequence', text: 'Synthetic point about the subject marker.', language: 'en' },
        ],
      },
      next: {
        fallbackText: 'Now picture the tent to the left of the camel and say that in Korean.',
        activity: {
          title: 'Tent and camel',
          purpose: 'Practice the same pattern with the tent as the subject.',
          instruction: {
            text: '텐트를 낙타 왼쪽에 놓고 한국어로 말해 보세요.',
            language: 'ko',
            gloss: 'Put the tent to the left of the camel, then say it in Korean.',
          },
          components: [
            {
              type: 'arrange',
              axis: { kind: 'viewer-left-right' },
              tokens: [
                {
                  key: 'a',
                  label: { text: '텐트', language: 'ko', gloss: 'tent' },
                  sourceId: null,
                },
                {
                  key: 'b',
                  label: { text: '낙타', language: 'ko', gloss: 'camel' },
                  sourceId: camel.sourceId,
                },
              ],
              target: { subject: 'a', relation: 'left-of', object: 'b' },
            },
          ],
          hints: [{ text: 'Start with the tent this time.', language: 'en' }],
        },
      },
    };
    await writeFile(
      replyPath,
      `Here is my reply as a JSON block.\n\n\`\`\`json\n${JSON.stringify(replyFile, null, 2)}\n\`\`\`\n`,
      { mode: 0o600 },
    );
    const replied = await cli('reply', '--file', replyPath);
    const replyId = /Imported reply (rep_[A-Za-z0-9_-]+)/.exec(replied)?.[1];
    const nextActivityId = /Next activity (act_[A-Za-z0-9_-]+) is ready/.exec(replied)?.[1];
    assert.ok(replyId && nextActivityId, 'The reply command names the reply and next activity.');
    check(`reply ${replyId} imported from a fenced json block; next activity ${nextActivityId}`);

    step = 'next activity';
    const next = await headset('GET', `/v1/activities/${nextActivityId}`);
    assert.equal(next.status, 'active');
    assert.deepEqual(next.provenance.parent, {
      activityId,
      submissionId: submission.submissionId,
      replyId,
    });
    assert.equal(next.provenance.requestId, request.requestId);
    assert.equal(
      (await headset('GET', `/v1/activities/${activityId}`)).submissions[0].reply.nextActivityId,
      nextActivityId,
    );
    check('next activity opens with its parent and the original request');

    step = 'repeated reply';
    assert.match(await cli('reply', '--file', replyPath), /imported before/);
    check('the same reply bytes again change nothing');

    step = 'restart';
    const before = { ...(await snapshot([activityId, nextActivityId])), counts: journalCounts() };
    await stop();
    stop = await startService(dataDir, headsetPort, connectorPort);
    const after = await snapshot([activityId, nextActivityId]);
    assert.deepEqual(after, { list: before.list, views: before.views });
    check('after a restart on the same journal the list and both views are identical');
    assert.deepEqual(journalCounts(), before.counts);
    check(`startup replay appended nothing (${before.counts.events} journal rows)`);

    return {
      result: 'pass',
      checks,
      packageId,
      requestId: request.requestId,
      activityId,
      submissionId: submission.submissionId,
      digest: submission.digest,
      replyId,
      nextActivityId,
      files: [requestName, submissionName],
    };
  } catch (error) {
    // Details can carry paths, so they stay in the private run folder; the message never does.
    await writeFile(
      join(dataDir, 'probe-error.log'),
      `${step}\n${error?.stack ?? String(error)}\n${error?.stderr ?? ''}\n`,
      { mode: 0o600, flag: 'wx' },
    ).catch(() => {});
    const exit = typeof error?.code === 'number' ? ` (exit code ${error.code})` : '';
    throw new Error(
      `The ${step} step failed${exit}; details are in probe-error.log in the run folder.`,
    );
  } finally {
    await stop();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.once(signal, () => {
      void Promise.all([...running].map((stop) => stop())).finally(() =>
        process.exit(signal === 'SIGINT' ? 130 : 143),
      );
    });
  try {
    const { values } = parseArgs({
      args: process.argv.slice(2),
      strict: true,
      options: {
        'headset-port': { type: 'string', default: '47910' },
        'connector-port': { type: 'string', default: '47911' },
        'data-root': { type: 'string', default: join(SERVICE, '.data', 'activity-loop') },
      },
    });
    const root = resolve(values['data-root']);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const dataDir = join(root, `run-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    await mkdir(dataDir, { mode: 0o700 });
    let summary;
    try {
      summary = await runActivityLoop({
        dataDir,
        headsetPort: Number(values['headset-port']),
        connectorPort: Number(values['connector-port']),
      });
    } catch (error) {
      // A refused run leaves no empty folder behind; rmdir removes only an empty one.
      await rmdir(dataDir).catch(() => {});
      throw error;
    }
    console.log(JSON.stringify({ ...summary, checks: summary.checks.length }, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'The activity loop probe failed.');
    process.exitCode = 1;
  }
}
