import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { request } from 'node:http';
import { test } from 'node:test';
import { NgrokDemoError, ngrokOrigin, startMuseNgrokDemo } from './muse-ngrok-demo.ts';

function fake(script: string) {
  let child: ChildProcess;
  let args: string[] = [];
  return {
    launch(input: string[]) {
      args = input;
      child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
      return child;
    },
    async cleaned() {
      assert.ok(child.exitCode !== null || child.signalCode !== null);
      const config = args[args.length - 1];
      assert.ok(config);
      await assert.rejects(access(config));
      assert.ok(args.includes('--inspect=false'));
      return args;
    },
  };
}
test('only credential-free HTTPS ngrok origins are accepted', () => {
  assert.equal(ngrokOrigin('https://fictional.ngrok-free.dev'), 'https://fictional.ngrok-free.dev');
  assert.equal(ngrokOrigin('https://fictional.ngrok-free.app'), 'https://fictional.ngrok-free.app');
  for (const url of [
    'https://example.com',
    'https://fictional.ngrok.pizza',
    'http://fictional.ngrok.app',
    'https://fictional.ngrok.app.evil.test',
    'https://user@fictional.ngrok.app',
    'https://fictional.ngrok.app/path',
  ])
    assert.throws(() => ngrokOrigin(url));
});
test('actual owned failed subprocess is reaped and private override removed', async () => {
  const child = fake('process.exit(2)');
  await assert.rejects(startMuseNgrokDemo({ startupMs: 2000 }, child.launch));
  await child.cleaned();
});
test('startup deadline kills an actual hanging subprocess and cleans override', async () => {
  const child = fake('setInterval(()=>{},1000)');
  await assert.rejects(startMuseNgrokDemo({ startupMs: 100 }, child.launch));
  await child.cleaned();
});
test('successful fake endpoint activates only synthetic demo and fixed deadline closes it', async () => {
  const child = fake(
    `console.log(JSON.stringify({msg:'started tunnel',url:'https://fictional.ngrok-free.app'}));setInterval(()=>{},1000)`,
  );
  const run = await startMuseNgrokDemo({ ttlMs: 5000 }, child.launch);
  assert.doesNotMatch(JSON.stringify(run.metadata), /marker|Bearer|synthetic-boopy/);
  const tokenFile = run.metadata.tokenFile;
  const status = await new Promise<number>((resolve, reject) => {
    const req = request(
      `${run.metadata.localGateUrl}/v1/context/${run.metadata.packageId}`,
      {
        headers: { host: new URL(run.metadata.origin).host },
      },
      (response) => {
        response.resume();
        response.once('end', () => resolve(response.statusCode ?? 0));
      },
    );
    req.once('error', reject);
    req.end();
  });
  assert.equal(status, 401);
  assert.equal(run.checkpoint().gateDiagnostics?.forwardedByRoute.package, 1);
  await run.closed;
  await child.cleaned();
  await assert.rejects(access(tokenFile));
  assert.equal(run.checkpoint().actualMuse, 'unverified');
  assert.equal(run.checkpoint().fullFetchDisclosures, 0);
  assert.equal(run.checkpoint().gateDiagnostics?.forwardedByRoute.package, 1);
  await assert.rejects(fetch(run.metadata.localGateUrl));
});

test('oversized vendor output is suppressed and owned process cleaned', async () => {
  const child = fake("process.stdout.write('x'.repeat(70000));setInterval(()=>{},1000)");
  await assert.rejects(startMuseNgrokDemo({ startupMs: 2000 }, child.launch));
  await child.cleaned();
});

test('invalid explicit origins are rejected before any process launch', async () => {
  let launches = 0;
  for (const origin of [
    'https://example.invalid',
    'https://fictional.ngrok-free.dev/path',
    'http://fictional.ngrok-free.dev',
    'https://user:password@fictional.ngrok-free.dev',
  ])
    await assert.rejects(
      startMuseNgrokDemo({ origin }, () => {
        launches++;
        throw new Error();
      }),
    );
  assert.equal(launches, 0);
});
test('explicit origin is requested exactly and a different returned ngrok origin is refused and cleaned', async () => {
  const child = fake(
    `console.log(JSON.stringify({msg:'started tunnel',url:'https://different.ngrok-free.dev'}));setInterval(()=>{},1000)`,
  );
  await assert.rejects(
    startMuseNgrokDemo(
      { origin: 'https://fictional.ngrok-free.dev', startupMs: 2000 },
      child.launch,
    ),
  );
  const args = await child.cleaned();
  assert.ok(args.includes('--url=https://fictional.ngrok-free.dev'));
  assert.equal(args.includes('--url=https://'), false);
});
test('matching explicit origin activates synthetic demo and cleanly removes its token', async () => {
  const child = fake(
    `console.log(JSON.stringify({msg:'started tunnel',url:'https://fictional.ngrok-free.dev'}));setInterval(()=>{},1000)`,
  );
  const run = await startMuseNgrokDemo(
    { origin: 'https://fictional.ngrok-free.dev', startupMs: 2000 },
    child.launch,
  );
  assert.equal(run.metadata.origin, 'https://fictional.ngrok-free.dev');
  const tokenFile = run.metadata.tokenFile;
  await run.close();
  const args = await child.cleaned();
  assert.ok(args.includes('--url=https://fictional.ngrok-free.dev'));
  await assert.rejects(access(tokenFile));
  await assert.rejects(fetch(run.metadata.localGateUrl));
});

test('stable account mismatch code is actionable without exposing vendor stderr and cleans child and gate', async () => {
  const child = fake(
    `process.stderr.write('PRIVATE account=user@example.invalid token=synthetic-secret domain=private.ngrok-free.dev ERR_NGROK_');setTimeout(()=>{process.stderr.write('320\\n');process.exit(1)},20)`,
  );
  await assert.rejects(
    startMuseNgrokDemo(
      { origin: 'https://fictional.ngrok-free.dev', startupMs: 2000 },
      child.launch,
    ),
    (error) => {
      assert.ok(error instanceof NgrokDemoError);
      assert.equal(error.code, 'account_mismatch');
      assert.match(error.message, /Update the local ngrok credential/);
      assert.doesNotMatch(error.message, /PRIVATE|user@|synthetic-secret|private\.ngrok/);
      return true;
    },
  );
  const args = await child.cleaned();
  await assert.rejects(fetch(args[1] as string));
});
test('unrecognized vendor codes and oversized stderr remain generic and private', async () => {
  for (const script of [
    "process.stderr.write('PRIVATE ERR_NGROK_3200 token=secret');process.exit(1)",
    "process.stderr.write('ERR_NGROK_320 '+ 'x'.repeat(70000));setInterval(()=>{},1000)",
  ]) {
    const child = fake(script);
    await assert.rejects(startMuseNgrokDemo({ startupMs: 2000 }, child.launch), (error) => {
      assert.ok(error instanceof NgrokDemoError);
      assert.equal(error.code, 'failed');
      assert.doesNotMatch(error.message, /PRIVATE|secret|ERR_NGROK/);
      return true;
    });
    await child.cleaned();
  }
});
