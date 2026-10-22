import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { exportPrepared } from '../cli/export-prepared.ts';
import { evidenceRecords } from '../evidence-contract.ts';
import { HandoffPreparation } from '../handoff-preparation.ts';
import { startRequest, testBoopy } from '../testing.ts';
import { connectorApp } from './connector.ts';

test('local prepared retrieval authenticates and enforces exact unchanged packet boundary', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'boopy-local-packet-'));
  const { boopy, journal } = testBoopy();
  let port = 0;
  const view = await boopy.start(startRequest('Synthetic retrieval only'));
  const packageId = boopy.commit(view.id).committed?.packageId;
  assert.ok(packageId);
  const token = 'synthetic-local-token';
  await writeFile(join(directory, 'connector-token'), token, { mode: 0o600 });
  const preparation = new HandoffPreparation({
    journal,
    outputRoot: join(directory, 'handoffs'),
    dataDir: directory,
    get port() {
      return port;
    },
    packageForId: (id) => boopy.package(id),
    sessionForId: (id) => boopy.view(id),
    supersessions: () => boopy.supersessions,
  });
  const app = connectorApp(boopy, {
    token,
    baseUrl: 'https://fictional.example',
    logger: false,
    handoff: preparation,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  port = (app.server.address() as AddressInfo).port;
  const path = `/v1/local-handoffs/${packageId}`;
  const authorization = `Bearer ${token}`;
  try {
    const receipt = await preparation.prepare(view.id, { requestId: 'first', packageId });
    for (const [headers, remoteAddress, expected] of [
      [{}, '127.0.0.1', 401],
      [{ authorization, host: 'fictional.example' }, '127.0.0.1', 403],
      [{ authorization, origin: 'http://localhost' }, '127.0.0.1', 403],
      [{ authorization, forwarded: 'for=127.0.0.1' }, '127.0.0.1', 403],
      [{ authorization, 'x-forwarded-for': '127.0.0.1' }, '127.0.0.1', 403],
      [{ authorization }, '192.0.2.1', 403],
    ] as const) {
      const response = await app.inject({
        url: path,
        headers: { host: '127.0.0.1', ...headers },
        remoteAddress,
      });
      assert.equal(response.statusCode, expected);
    }
    const metadata = (
      await app.inject({
        url: path,
        headers: { host: '127.0.0.1', authorization },
        remoteAddress: '127.0.0.1',
      })
    ).json();
    assert.equal(metadata.sourceState, 'unchanged');
    assert.equal(JSON.stringify(metadata).includes(directory), false);
    assert.equal(
      (
        await app.inject({
          url: '/v1/local-handoffs/ctx_unknown',
          headers: { host: '127.0.0.1', authorization },
          remoteAddress: '127.0.0.1',
        })
      ).statusCode,
      404,
    );
    const packet = await preparation.readPacket(view.id, 'first');
    const output = join(directory, 'export.txt');
    const exported = await exportPrepared({ packageId, dataDir: directory, output, port });
    assert.equal(exported.bytes, Buffer.byteLength(packet));
    assert.equal(await readFile(output, 'utf8'), packet);
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    await assert.rejects(exportPrepared({ packageId, dataDir: directory, output, port }));
    assert.equal(await readFile(output, 'utf8'), packet);
    const artifact = join(
      directory,
      'handoffs',
      `${receipt.receiptId}-attempt-1`,
      'manual-handoff-packet.txt',
    );
    await writeFile(artifact, 'synthetic corruption');
    assert.equal(
      (
        await app.inject({
          url: `${path}/packet`,
          headers: { host: '127.0.0.1', authorization },
          remoteAddress: '127.0.0.1',
        })
      ).statusCode,
      404,
    );
    await writeFile(artifact, packet);
    const next = await boopy.start(startRequest('Synthetic successor'));
    const nextId = boopy.commit(next.id).committed?.packageId;
    assert.ok(nextId);
    const predecessor = evidenceRecords(boopy.package(packageId))[0];
    const successor = evidenceRecords(boopy.package(nextId))[0];
    assert.ok(predecessor && successor);
    boopy.supersede({ predecessor, successor });
    assert.equal(preparation.status(view.id, 'first')?.state, 'prepared-local');
    assert.equal(preparation.forPackage(packageId).sourceState, 'changed');
    assert.equal(
      (
        await app.inject({
          url: `${path}/packet`,
          headers: { host: '127.0.0.1', authorization },
          remoteAddress: '127.0.0.1',
        })
      ).statusCode,
      404,
    );
    await preparation.prepare(view.id, { requestId: 'second', packageId });
    assert.throws(() => preparation.forPackage(packageId));
    const get = (suffix: string) =>
      app.inject({
        url: `${path}${suffix}`,
        headers: { host: '127.0.0.1', authorization },
        remoteAddress: '127.0.0.1',
      });
    const listing = (await get('?list=true')).json();
    assert.deepEqual(
      listing.preparations.map((entry: { requestId: string; sourceState: string }) => [
        entry.requestId,
        entry.sourceState,
      ]),
      [
        ['first', 'changed'],
        ['second', 'unchanged'],
      ],
    );
    assert.equal(JSON.stringify(listing).includes('Synthetic'), false);
    assert.equal((await get('/packet?request=first')).statusCode, 404);
    assert.equal((await get('/packet?request=second')).statusCode, 200);
    assert.equal((await get('/packet?request=unknown')).statusCode, 404);
    assert.equal((await get('/packet?request=second&extra=true')).statusCode, 404);
    assert.equal((await get('/packet?request=first&request=second')).statusCode, 404);
    assert.equal((await get('/packet?list=true')).statusCode, 404);
    assert.throws(() => preparation.forPackage(nextId, 'second'));
    const selectedOutput = join(directory, 'explicit-selected.txt');
    await exportPrepared({
      packageId,
      dataDir: directory,
      output: selectedOutput,
      port,
      requestId: 'second',
    });
    assert.equal(
      await readFile(selectedOutput, 'utf8'),
      await preparation.readPacket(view.id, 'second'),
    );
  } finally {
    app.server.closeAllConnections();
    await app.close();
    journal.close();
    await rm(directory, { recursive: true, force: true });
  }
});
