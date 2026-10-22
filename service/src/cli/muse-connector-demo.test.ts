import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { test } from 'node:test';
import { evidenceRecords } from '../evidence-contract.ts';
import { demoOrigin, startMuseConnectorDemo } from './muse-connector-demo.ts';

test('isolated connector fetch preserves all synthetic trust categories and leaks no credential metadata', async () => {
  const demo = await startMuseConnectorDemo();
  const { metadata } = demo;
  try {
    const token = await readFile(metadata.tokenFile, 'utf8');
    assert.match(token, /^[a-f0-9]{64}$/);
    assert.equal((await stat(metadata.tokenFile)).mode & 0o777, 0o600);
    assert.equal((await stat(dirname(metadata.tokenFile))).mode & 0o777, 0o700);
    assert.equal(JSON.stringify(metadata).includes(token), false);
    assert.equal(metadata.actualMuse, 'unverified');
    for (const headers of [
      new Headers(),
      new Headers({ authorization: 'Bearer wrong-synthetic' }),
    ]) {
      const denied = await fetch(`${metadata.localUrl}/v1/context/${metadata.packageId}`, {
        headers,
      });
      assert.equal(denied.status, 401);
    }
    assert.equal(demo.checkpoint().disclosures, 0);
    const response = await fetch(`${metadata.localUrl}/v1/context/${metadata.packageId}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 200);
    const pkg = await response.json();
    assert.ok(pkg.text.includes(metadata.marker));
    const records = evidenceRecords(pkg);
    for (const verification of ['accepted', 'confirmed', 'corrected', 'authored'])
      assert.ok(records.some((record) => record.verification === verification));
    for (const disposition of ['known', 'rejected', 'question'])
      assert.ok(records.some((record) => record.disposition === disposition));
    assert.ok(records.some((record) => record.note === 'this synthetic claim is unsupported'));
    assert.equal(demo.checkpoint().fullFetchDisclosures, 1);
    for (const path of ['/v1/sessions', '/v1/health', '/media/frame.jpg', '/v1/recall']) {
      const blocked = await fetch(`${metadata.localUrl}${path}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(blocked.status, 404);
    }
    const spec = await (await fetch(`${metadata.localUrl}/openapi.json`)).json();
    assert.equal(spec.servers[0].url, metadata.localUrl);
    assert.equal(JSON.stringify(spec).includes(token), false);
    assert.equal(JSON.stringify(spec).includes(metadata.marker), false);
  } finally {
    await demo.close();
  }
  await assert.rejects(stat(metadata.tokenFile));
  await assert.rejects(stat(dirname(metadata.tokenFile)));
});

test('explicit origin validation and TTL bounds reject before serving', async () => {
  assert.equal(demoOrigin('https://synthetic.example/'), 'https://synthetic.example');
  for (const origin of [
    'http://synthetic.example',
    'https://user:secret@synthetic.example',
    'https://synthetic.example/path',
    'https://synthetic.example?q=token',
    'https://synthetic.example#token',
    'not a URL',
  ])
    await assert.rejects(startMuseConnectorDemo({ origin }), /HTTPS origin/);
  for (const ttlMs of [0, -1, Number.NaN, 1800001, 1.5])
    await assert.rejects(startMuseConnectorDemo({ ttlMs }), /TTL/);
});

test('TTL shuts listener and removes disposable credential; close is idempotent', async () => {
  const demo = await startMuseConnectorDemo({ ttlMs: 20 });
  await demo.closed;
  await demo.close();
  await assert.rejects(stat(demo.metadata.tokenFile));
  await assert.rejects(fetch(`${demo.metadata.localUrl}/health`));
});
