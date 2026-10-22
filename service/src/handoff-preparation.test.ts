import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { exportHandoff } from './cli/export-handoff.ts';
import { evidenceRecords } from './evidence-contract.ts';
import { HandoffPreparation, HandoffPreparationRequest } from './handoff-preparation.ts';
import { connectorApp } from './http/connector.ts';
import { startRequest, testBoopy } from './testing.ts';

async function setup(compose?: typeof exportHandoff) {
  const directory = await mkdtemp(join(tmpdir(), 'boopy-preparation-test-'));
  const test = testBoopy();
  const view = await test.boopy.start(startRequest('Synthetic dunes only.'));
  const packageId = test.boopy.commit(view.id).committed?.packageId;
  assert.ok(packageId);
  const token = 'synthetic-local-preparation-token';
  await writeFile(join(directory, 'connector-token'), token, { mode: 0o600 });
  const app = connectorApp(test.boopy, {
    token,
    baseUrl: 'http://127.0.0.1',
    logger: false,
    memory: true,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const outputRoot = join(directory, 'handoffs');
  const dependencies = {
    journal: test.journal,
    outputRoot,
    dataDir: directory,
    port: (app.server.address() as AddressInfo).port,
    packageForId: (id: string) => test.boopy.package(id),
    sessionForId: (id: string) => test.boopy.view(id),
    compose,
    supersessions: () => test.boopy.supersessions,
  };
  return {
    ...test,
    view,
    packageId,
    directory,
    outputRoot,
    dependencies,
    preparation: new HandoffPreparation(dependencies),
    request: { requestId: 'synthetic-preparation-1', packageId },
    async close() {
      await app.close();
      test.journal.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

it('prepares exact local packet through real connector/exporter and persists metadata-only idempotent receipt', async () => {
  const test = await setup();
  try {
    const receipt = await test.preparation.prepare(test.view.id, test.request);
    assert.equal(receipt.state, 'prepared-local');
    assert.equal(receipt.delivery, 'not-sent');
    assert.equal(receipt.memory.status, 'disabled');
    assert.equal(receipt.references.status, 'disabled');
    assert.ok(receipt.selectedSourceIds.length > 0);
    assert.equal(JSON.stringify(receipt).includes(test.directory), false);
    assert.equal(JSON.stringify(receipt).includes('Synthetic dunes only.'), false);
    const packet = await test.preparation.readPacket(test.view.id, test.request.requestId);
    const pkg = test.boopy.package(test.packageId);
    assert.ok(pkg);
    assert.ok(packet.includes(pkg.text));
    assert.ok(packet.includes('Nothing has been sent to Muse'));
    assert.ok(
      test.journal
        .all()
        .some(
          (event) =>
            event.type === 'handoff.packet-read' &&
            event.actor === 'agent:local-operator' &&
            event.data.packetSha256 === receipt.packetSha256,
        ),
    );
    const recreated = new HandoffPreparation(test.dependencies);
    assert.deepEqual(await recreated.prepare(test.view.id, test.request), receipt);
    assert.equal((await readdir(test.outputRoot)).length, 1);
    const events = test.journal
      .all()
      .filter((event) => event.type.startsWith('handoff.preparation'));
    assert.equal(events.length, 2);
    const started = events[0];
    assert.equal(started?.type, 'handoff.preparation-started');
    if (started?.type === 'handoff.preparation-started') {
      assert.deepEqual(started.data.selection, test.request);
      assert.equal(started.data.consent, 'prepare-local-only');
    }
  } finally {
    await test.close();
  }
});

it('rejects changed selection, cross-session reuse, unknown optional scope and injected client paths before output', async () => {
  const test = await setup();
  try {
    assert.throws(() => test.preparation.prepare('different-session', test.request));
    assert.throws(() =>
      test.preparation.prepare(test.view.id, {
        ...test.request,
        memory: { packageIds: ['ctx_missing'], query: 'synthetic' },
      }),
    );
    assert.throws(() =>
      HandoffPreparationRequest.parse({ ...test.request, outputRoot: '/tmp/elsewhere' }),
    );
    assert.throws(() =>
      HandoffPreparationRequest.parse({
        ...test.request,
        references: {
          packageId: test.packageId,
          itemId: 'synthetic',
          conceptKey: 'dune',
          referenceId: 'Q8514',
          credentialFile: '/tmp/secret',
        },
      }),
    );
    await assert.rejects(readdir(test.outputRoot));
    await test.preparation.prepare(test.view.id, test.request);
    assert.throws(
      () =>
        test.preparation.prepare(test.view.id, {
          ...test.request,
          memory: { packageIds: [test.packageId], query: 'changed selection' },
        }),
      /selection changed/,
    );
    const other = await test.boopy.start(startRequest('Another synthetic session.'));
    const otherPackage = test.boopy.commit(other.id).committed?.packageId;
    assert.ok(otherPackage);
    assert.throws(
      () => test.preparation.prepare(other.id, { ...test.request, packageId: otherPackage }),
      /unavailable/,
    );
    assert.equal((await readdir(test.outputRoot)).length, 1);
  } finally {
    await test.close();
  }
});

it('coalesces concurrent identical preparations without duplicate exports', async () => {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const test = await setup(async (options, dependencies) => {
    calls += 1;
    await gate;
    return exportHandoff(options, dependencies);
  });
  try {
    const first = test.preparation.prepare(test.view.id, test.request);
    const second = test.preparation.prepare(test.view.id, test.request);
    assert.equal(first, second);
    release();
    assert.deepEqual(await first, await second);
    assert.equal(calls, 1);
  } finally {
    release();
    await test.close();
  }
});

it('recovers interrupted preparation in the same journal and bounds fresh private retry attempts', async () => {
  const test = await setup(async () => {
    throw new Error('synthetic secret provider failure');
  });
  try {
    await assert.rejects(
      test.preparation.prepare(test.view.id, test.request),
      /^Error: Local handoff preparation failed\.$/,
    );
    const first = test.journal.all().find((event) => event.type === 'handoff.preparation-started');
    assert.ok(first?.type === 'handoff.preparation-started');
    test.journal.append(
      {
        type: 'handoff.preparation-started',
        actor: 'person',
        session: test.view.id,
        data: { ...first.data, attempt: 2 },
      },
      'synthetic-interrupted-start',
      new Date().toISOString(),
    );
    const recovered = new HandoffPreparation(test.dependencies);
    assert.equal(recovered.status(test.view.id, test.request.requestId)?.state, 'failed');
    assert.ok(
      test.journal
        .all()
        .some(
          (event) =>
            event.type === 'handoff.preparation-failed' && event.data.reason === 'interrupted',
        ),
    );
    await assert.rejects(recovered.prepare(test.view.id, test.request));
    assert.throws(() => recovered.prepare(test.view.id, test.request), /retry limit/);
    assert.equal((await readdir(test.outputRoot)).length, 2);
    assert.equal(
      JSON.stringify(recovered.status(test.view.id, test.request.requestId)).includes('secret'),
      false,
    );
  } finally {
    await test.close();
  }
});

it('keeps exact baseline when an explicitly selected reference lacks configured credentials', async () => {
  const test = await setup();
  try {
    const pkg = test.boopy.package(test.packageId);
    assert.ok(pkg);
    const record = evidenceRecords(pkg).find((item) => item.disposition === 'context');
    assert.ok(record);
    const receipt = await test.preparation.prepare(test.view.id, {
      ...test.request,
      references: {
        packageId: test.packageId,
        itemId: record.itemId,
        conceptKey: 'dune',
        referenceId: 'Q25391',
      },
    });
    assert.equal(receipt.references.status, 'unavailable');
    assert.equal(receipt.references.returnedAssociations, 0);
    const packet = await test.preparation.readPacket(test.view.id, test.request.requestId);
    assert.ok(packet.includes(pkg.text));
    assert.ok(packet.includes('unavailable'));
  } finally {
    await test.close();
  }
});

it('refuses altered packets and nonprivate app storage', async () => {
  const test = await setup();
  try {
    await mkdir(test.outputRoot, { mode: 0o755 });
    await assert.rejects(test.preparation.prepare(test.view.id, test.request));
    await rm(test.outputRoot, { recursive: true });
    const receipt = await test.preparation.prepare(test.view.id, test.request);
    const status = test.preparation.status(test.view.id, test.request.requestId);
    assert.ok(status);
    const path = join(
      test.outputRoot,
      `${receipt.receiptId}-attempt-${status.attempt}`,
      'manual-handoff-packet.txt',
    );
    await writeFile(path, `${await readFile(path, 'utf8')}\nSYNTHETIC TAMPERING`);
    await assert.rejects(
      test.preparation.readPacket(test.view.id, test.request.requestId),
      /integrity/,
    );
    await rm(path);
    await symlink(join(test.directory, 'connector-token'), path);
    await assert.rejects(test.preparation.readPacket(test.view.id, test.request.requestId));
    assert.equal(
      test.journal.all().filter((event) => event.type === 'handoff.packet-read').length,
      0,
    );
  } finally {
    await test.close();
  }
});

it('limits work to one preparation per session and two across the service', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const test = await setup(async (options, dependencies) => {
    await gate;
    return exportHandoff(options, dependencies);
  });
  try {
    const second = await test.boopy.start(startRequest('Second synthetic source.'));
    const secondPackage = test.boopy.commit(second.id).committed?.packageId;
    const third = await test.boopy.start(startRequest('Third synthetic source.'));
    const thirdPackage = test.boopy.commit(third.id).committed?.packageId;
    assert.ok(secondPackage && thirdPackage);
    const firstWork = test.preparation.prepare(test.view.id, test.request);
    assert.throws(
      () =>
        test.preparation.prepare(test.view.id, {
          ...test.request,
          requestId: 'same-session-other',
        }),
      /busy/,
    );
    const secondWork = test.preparation.prepare(second.id, {
      requestId: 'second-request',
      packageId: secondPackage,
    });
    assert.throws(
      () =>
        test.preparation.prepare(third.id, { requestId: 'third-request', packageId: thirdPackage }),
      /busy/,
    );
    release();
    await Promise.all([firstWork, secondWork]);
  } finally {
    release();
    await test.close();
  }
});

for (const during of [false, true]) {
  it(`refuses ${during ? 'completion' : 'packet read'} when selected correction provenance changes`, async () => {
    let correct: (() => void) | undefined;
    const test = await setup(async (options, dependencies) => {
      const result = await exportHandoff(options, dependencies);
      if (during) correct?.();
      return result;
    });
    try {
      const next = await test.boopy.start(startRequest('Corrected synthetic source.'));
      const nextPackageId = test.boopy.commit(next.id).committed?.packageId;
      assert.ok(nextPackageId);
      const predecessor = evidenceRecords(test.boopy.package(test.packageId))[0];
      const successor = evidenceRecords(test.boopy.package(nextPackageId))[0];
      assert.ok(predecessor && successor);
      correct = () => {
        test.boopy.supersede({ predecessor, successor });
      };
      if (during) {
        await assert.rejects(test.preparation.prepare(test.view.id, test.request));
        assert.equal(
          test.preparation.status(test.view.id, test.request.requestId)?.state,
          'failed',
        );
      } else {
        const receipt = await test.preparation.prepare(test.view.id, test.request);
        assert.equal(receipt.historicalSnapshot, true);
        assert.ok(Number.isFinite(Date.parse(receipt.preparedAt)));
        correct();
        await assert.rejects(
          test.preparation.readPacket(test.view.id, test.request.requestId),
          /sources changed/,
        );
        assert.deepEqual(await test.preparation.prepare(test.view.id, test.request), receipt);
      }
      assert.equal(
        test.journal.all().filter((event) => event.type === 'handoff.packet-read').length,
        0,
      );
    } finally {
      await test.close();
    }
  });
}
