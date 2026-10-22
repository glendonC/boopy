import assert from 'node:assert/strict';
import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { portFree, runActivityLoop } from './activity-loop.mjs';

/** Ports the kernel just handed out, so the run never meets a real Boopy on 47900 or 47910. */
async function freePorts(count) {
  const servers = await Promise.all(
    Array.from(
      { length: count },
      () =>
        new Promise((resolve) => {
          const server = createServer();
          server.listen(0, '127.0.0.1', () => resolve(server));
        }),
    ),
  );
  const ports = servers.map((server) => server.address().port);
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  return ports;
}

test('runs the synthetic loop on a real isolated service and replays it after a restart', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'boopy-activity-loop-'));
  const [headsetPort, connectorPort] = await freePorts(2);
  const lines = [];
  try {
    const summary = await runActivityLoop({
      dataDir,
      headsetPort,
      connectorPort,
      log: (line) => lines.push(line),
    });
    assert.equal(summary.result, 'pass');
    for (const check of [
      'headset health carries activities: true',
      'a stale submission is refused with 409 stale_activity',
      'the same reply bytes again change nothing',
      'after a restart on the same journal the list and both views are identical',
      'startup replay appended nothing',
    ])
      assert.ok(
        summary.checks.some((name) => name.startsWith(check)),
        check,
      );
    assert.match(summary.packageId, /^ctx_/);
    assert.match(summary.requestId, /^arq_/);
    assert.match(summary.activityId, /^act_/);
    assert.match(summary.submissionId, /^sub_/);
    assert.match(summary.replyId, /^rep_/);
    assert.match(summary.nextActivityId, /^act_/);
    assert.equal(
      summary.digest,
      'arrange: 낙타 left of 텐트 (your view); requested 낙타 left of 텐트; arrangement matches | sequence: "낙타가 텐트 왼쪽에 있어요" | hints: 1 of 2',
    );
    assert.deepEqual(summary.files, [
      `boopy-activity-request-${summary.requestId}.json`,
      `boopy-activity-submission-${summary.submissionId}.json`,
    ]);
    for (const name of summary.files)
      assert.equal((await stat(join(dataDir, 'files', name))).mode & 0o777, 0o600);
    const printed = lines.join('\n');
    const token = (await readFile(join(dataDir, 'connector-token'), 'utf8')).trim();
    assert.equal(printed.includes(dataDir), false);
    assert.equal(printed.includes(token), false);
    assert.equal(printed.includes('Nothing has been sent to Muse'), false);
    assert.ok(await portFree(headsetPort));
    assert.ok(await portFree(connectorPort));
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('refuses busy ports and a data directory that is not new and private, starting nothing', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'boopy-activity-loop-refusals-'));
  const blocker = createServer();
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  const busy = blocker.address().port;
  const [free, other] = await freePorts(2);
  const quiet = { log() {} };
  try {
    assert.equal(await portFree(busy), false);
    await assert.rejects(
      runActivityLoop({ ...quiet, dataDir, headsetPort: busy, connectorPort: free }),
      /in use/,
    );
    await assert.rejects(
      runActivityLoop({ ...quiet, dataDir, headsetPort: free, connectorPort: busy }),
      /in use/,
    );
    await assert.rejects(
      runActivityLoop({ ...quiet, dataDir, headsetPort: free, connectorPort: free }),
      /two different/,
    );
    for (const port of [47900, 47901, 0, 70000])
      await assert.rejects(
        runActivityLoop({ ...quiet, dataDir, headsetPort: port, connectorPort: other }),
        /port/,
      );
    assert.deepEqual(await readdir(dataDir), []);
    await chmod(dataDir, 0o755);
    await assert.rejects(
      runActivityLoop({ ...quiet, dataDir, headsetPort: free, connectorPort: other }),
      /private/,
    );
    await chmod(dataDir, 0o700);
    await writeFile(join(dataDir, 'earlier'), 'synthetic');
    await assert.rejects(
      runActivityLoop({ ...quiet, dataDir, headsetPort: free, connectorPort: other }),
      /empty/,
    );
    assert.deepEqual(await readdir(dataDir), ['earlier']);
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
});
