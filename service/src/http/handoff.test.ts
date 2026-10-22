import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { HandoffPreparation } from '../handoff-preparation.ts';
import { startRequest, testBoopy } from '../testing.ts';
import { connectorApp } from './connector.ts';
import { headsetApp } from './headset.ts';

it('headset prepares and recovers a real local packet without exposing its text, paths or token', async () => {
  const fixture = testBoopy();
  const directory = await mkdtemp(join(tmpdir(), 'boopy-headset-handoff-'));
  const token = 'synthetic-handoff-http-token';
  await writeFile(join(directory, 'connector-token'), token, { mode: 0o600 });
  const connector = connectorApp(fixture.boopy, {
    token,
    baseUrl: 'http://127.0.0.1',
    logger: false,
    memory: true,
  });
  await connector.listen({ host: '127.0.0.1', port: 0 });
  const preparation = new HandoffPreparation({
    journal: fixture.journal,
    outputRoot: join(directory, 'handoffs'),
    dataDir: directory,
    port: (connector.server.address() as AddressInfo).port,
    packageForId: (id) => fixture.boopy.package(id),
    sessionForId: (id) => fixture.boopy.view(id),
    supersessions: () => fixture.boopy.supersessions,
  });
  const app = headsetApp(fixture.boopy, { logger: false, handoff: preparation });
  try {
    const started = await app.inject({
      method: 'POST',
      url: '/v1/sessions',
      payload: startRequest('Fictional desert hike only.'),
    });
    const sessionId = started.json().id as string;
    const saved = await app.inject({ method: 'POST', url: `/v1/sessions/${sessionId}/commit` });
    const packageId = saved.json().committed.packageId as string;
    const request = {
      requestId: 'synthetic-native-prepare',
      packageId,
      memory: { packageIds: [packageId], query: 'Desert photo' },
    };
    const url = `/v1/sessions/${sessionId}/handoff-preparations`;
    assert.equal((await app.inject('/v1/health')).json().handoffPreparationAvailable, true);
    for (const origin of ['https://unrelated.example', 'null', 'http://127.0.0.1']) {
      assert.equal(
        (await app.inject({ method: 'POST', url, payload: request, headers: { origin } }))
          .statusCode,
        403,
      );
    }
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url,
          payload: JSON.stringify(request),
          headers: { 'content-type': 'text/plain' },
        })
      ).statusCode,
      415,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url,
          payload: { ...request, outputDirectory: '/tmp/not-allowed' },
        })
      ).statusCode,
      400,
    );
    assert.equal(preparation.status(sessionId, request.requestId), null);
    const initial = await app.inject({ method: 'POST', url, payload: request });
    assert.equal(initial.statusCode, 202);
    assert.equal(initial.json().state, 'preparing-local');
    assert.equal(initial.headers['cache-control'], 'no-store');
    // Join the same real job to avoid a timing-dependent polling assertion.
    const receipt = await preparation.prepare(sessionId, request);
    assert.equal(receipt.memory.status, 'available');
    const recovered = await app.inject(`${url}/${request.requestId}`);
    assert.equal(recovered.statusCode, 200);
    assert.equal(recovered.json().receipt.delivery, 'not-sent');
    assert.equal(recovered.json().receipt.packetSha256, receipt.packetSha256);
    for (const secret of [directory, token, 'Fictional desert hike only.', 'Desert photo'])
      assert.equal(recovered.body.includes(secret), false);
    assert.equal((await app.inject({ method: 'POST', url, payload: request })).statusCode, 200);
    assert.equal(
      (await app.inject({ method: 'POST', url, payload: { ...request, memory: undefined } }))
        .statusCode,
      409,
    );
    assert.equal(
      (await app.inject(`/v1/sessions/another-session/handoff-preparations/${request.requestId}`))
        .statusCode,
      404,
    );
    assert.equal((await app.inject(`${url}/${request.requestId}/packet`)).statusCode, 404);
    const packet = await preparation.readPacket(sessionId, request.requestId);
    const savedPackage = fixture.boopy.package(packageId);
    assert.ok(savedPackage);
    assert.ok(packet.includes(savedPackage.text));
    assert.equal(
      fixture.journal.all().filter((event) => event.type === 'handoff.preparation-completed')
        .length,
      1,
    );
  } finally {
    await app.close();
    await connector.close();
    fixture.journal.close();
    await rm(directory, { recursive: true, force: true });
  }
});
