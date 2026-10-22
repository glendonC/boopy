import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = dirname(fileURLToPath(import.meta.url));
const jdk =
  process.env.BOOPY_PROBE_JDK ??
  '/Applications/Unity/Hub/Editor/6000.3.25f1/PlaybackEngines/AndroidPlayer/OpenJDK';
test('synthetic JDBC double proves safe stdin, exact query, timeout-support flags and suppressed errors', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'boopy-jdbc-tests-'));
  try {
    await chmod(directory, 0o700);
    await exec(join(jdk, 'bin/javac'), [
      '--release',
      '8',
      '-d',
      directory,
      join(root, 'fixtures/LightningDriver.java'),
    ]);
    const credential = join(directory, 'credentials');
    await writeFile(credential, 'synthetic-user\nsynthetic-password\n', { mode: 0o600 });
    const env = { ...process.env, BOOPY_PROBE_JDK: jdk, BOOPY_PROBE_JAR: directory };
    const good = await exec(process.execPath, [join(root, 'run.mjs'), credential, '--metadata'], {
      env,
      timeout: 30000,
    });
    const result = JSON.parse(good.stdout);
    assert.equal(result.outcome, 'passed');
    assert.equal(result.rows, 1);
    assert.equal(result.columns, 1);
    assert.equal(result.queryTimeoutConfigured, false);
    assert.equal(result.driverVersion, 'synthetic-0.1');
    assert.doesNotMatch(good.stdout + good.stderr, /synthetic-user|synthetic-password|sensitive/);
    await writeFile(credential, 'synthetic-user\nwrong-private-value\n');
    await assert.rejects(
      exec(process.execPath, [join(root, 'run.mjs'), credential], { env, timeout: 30000 }),
      (error) => {
        assert.equal(JSON.parse(error.stdout).outcome, 'failed');
        assert.doesNotMatch(
          error.stdout + error.stderr,
          /wrong-private-value|synthetic-user|sensitive/,
        );
        return true;
      },
    );
    await writeFile(credential, 'synthetic-hang\nsynthetic-password\n');
    const started = Date.now();
    await assert.rejects(
      exec(process.execPath, [join(root, 'run.mjs'), credential], { env, timeout: 30000 }),
      (error) => {
        assert.equal(JSON.parse(error.stdout).outcome, 'timeout');
        assert.doesNotMatch(error.stdout + error.stderr, /synthetic-hang|synthetic-password/);
        assert.ok(Date.now() - started < 26000);
        return true;
      },
    );
    await chmod(credential, 0o644);
    await assert.rejects(
      exec(process.execPath, [join(root, 'run.mjs'), credential], { env }),
      /failed/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
