import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  lookupZetarisReference,
  ZetarisReferenceAssociation,
  ZetarisReferenceError,
} from './zetaris.ts';

const result = {
  mode: 'zetaris-runtime',
  operation: 'reference-lookup',
  rows: [
    {
      referenceSourceId: 'wikidata:Q25391',
      referenceId: 'Q25391',
      koreanTerm: '사구',
      englishGloss: 'dune',
      referenceVersion: '2546278779',
      updatedAt: '1970-01-01T16:49:42Z',
      referenceStatus: 'external-unreviewed',
      referenceUrl: 'https://www.wikidata.org/wiki/Q25391',
      license: 'CC0-1.0',
    },
  ],
};
async function fixture(work: (path: string, directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'boopy-reference-test-'));
  const path = join(directory, 'credentials');
  try {
    await writeFile(path, 'boopy-reference-1970-01-01@example.invalid\nsynthetic-only-password\n', {
      mode: 0o600,
    });
    await work(path, directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
test('fresh lookup sends only credential path and cancellation, retaining external attribution', async () => {
  await fixture(async (path) => {
    const options = {
      referenceId: 'Q25391',
      credentialFile: path,
      selectedPrivateContext: 'Synthetic statement must never be transmitted.',
    };
    const returned = await lookupZetarisReference(options, async (request) => {
      assert.deepEqual(Object.keys(request).sort(), ['credentialFile', 'referenceId', 'signal']);
      assert.doesNotMatch(JSON.stringify(request), /Synthetic statement/);
      return result;
    });
    assert.deepEqual(returned, result);
    assert.equal(returned.rows[0]?.referenceStatus, 'external-unreviewed');
  });
});
test('unsupported reference, setup admin, unsafe permissions and symlinks fail before query', async () => {
  await fixture(async (path, directory) => {
    let calls = 0;
    const execute = async () => {
      calls++;
      return result;
    };
    await assert.rejects(
      lookupZetarisReference({ referenceId: 'QOTHER', credentialFile: path }, execute),
    );
    await chmod(path, 0o644);
    await assert.rejects(
      lookupZetarisReference({ referenceId: 'Q25391', credentialFile: path }, execute),
    );
    await chmod(path, 0o600);
    const alias = join(directory, 'alias');
    await symlink(path, alias);
    await assert.rejects(
      lookupZetarisReference({ referenceId: 'Q25391', credentialFile: alias }, execute),
    );
    await writeFile(path, 'synthetic-admin\nsynthetic-only-password\n');
    await assert.rejects(
      lookupZetarisReference({ referenceId: 'Q25391', credentialFile: path }, execute),
    );
    assert.equal(calls, 0);
  });
});
test('malformed results and adapter errors are sanitized without a substitute reference', async () => {
  await fixture(async (path) => {
    const options = { referenceId: 'Q25391', credentialFile: path };
    for (const raw of [
      { ...result, rows: [] },
      { ...result, rows: [result.rows[0], result.rows[0]] },
      { ...result, rows: [{ ...result.rows[0], license: 'guessed' }] },
      { ...result, rows: [{ ...result.rows[0], referenceStatus: 'confirmed' }] },
      { ...result, rows: [{ ...result.rows[0], updatedAt: 'unknown' }] },
      { ...result, secret: 'synthetic-private' },
    ])
      await assert.rejects(
        lookupZetarisReference(options, async () => raw),
        /^Error: Zetaris reference unavailable\.$/,
      );
    await assert.rejects(
      lookupZetarisReference(options, async () => {
        throw new Error('synthetic-private password');
      }),
      (error) => {
        assert.doesNotMatch(String(error), /synthetic-private|password/);
        return true;
      },
    );
  });
});
test('cancellation suppresses successful late results and pre-cancelled work makes no query', async () => {
  await fixture(async (path) => {
    const cancel = new AbortController();
    await assert.rejects(
      lookupZetarisReference(
        { referenceId: 'Q25391', credentialFile: path, signal: cancel.signal },
        async () => {
          cancel.abort();
          return result;
        },
      ),
      /cancelled/,
    );
    let called = false;
    await assert.rejects(
      lookupZetarisReference(
        { referenceId: 'Q25391', credentialFile: path, signal: AbortSignal.abort() },
        async () => {
          called = true;
          return result;
        },
      ),
      /cancelled/,
    );
    assert.equal(called, false);
  });
});

test('default subprocess cancellation reaps a stalled compiler and removes its private classes', async () => {
  await subprocessCancellation('javac', false);
});
test('timed abort reaps a stalled JVM and removes its private classes', async () => {
  await subprocessCancellation('java', true);
});

async function subprocessCancellation(stalledStage: 'javac' | 'java', timed: boolean) {
  await fixture(async (credentialFile, directory) => {
    const { mkdir, stat } = await import('node:fs/promises');
    const { createServer } = await import('node:net');
    const bin = join(directory, 'jdk', 'bin');
    await mkdir(bin, { recursive: true });
    const socketPath = join(directory, 'r');
    let reportReady: (info: { pid: number; classes: string }) => void = () => {};
    const ready = new Promise<{ pid: number; classes: string }>((resolve) => {
      reportReady = resolve;
    });
    const server = createServer((socket) => {
      let message = '';
      socket.on('data', (chunk) => {
        message += chunk;
      });
      socket.on('end', () => {
        reportReady(JSON.parse(message));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    for (const stage of ['javac', 'java']) {
      const code =
        stage === stalledStage
          ? `const net=require('node:net');const at=process.argv.indexOf('-d');const classes=at<0?process.argv[process.argv.indexOf('-cp')+1].split(':')[0]:process.argv[at+1];const ready=net.createConnection(${JSON.stringify(socketPath)});ready.on('connect',()=>ready.end(JSON.stringify({pid:process.pid,classes})));setInterval(()=>{},1000);`
          : 'process.exit(0);';
      await writeFile(join(bin, stage), `#!${process.execPath}\n${code}\n`, { mode: 0o700 });
    }
    const prior = process.env.BOOPY_PROBE_JDK;
    process.env.BOOPY_PROBE_JDK = join(directory, 'jdk');
    const cancel = new AbortController();
    const pending = lookupZetarisReference({
      referenceId: 'Q25391',
      credentialFile,
      signal: cancel.signal,
    });
    const stopped = assert.rejects(pending, /cancelled/);
    let readinessTimeout: ReturnType<typeof setTimeout> | undefined;
    let cancellationTimeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const processInfo = await Promise.race([
        ready,
        new Promise<never>((_resolve, reject) => {
          readinessTimeout = setTimeout(
            () => reject(new Error('Owned compiler/JVM readiness handshake did not arrive.')),
            10000,
          );
        }),
      ]);
      clearTimeout(readinessTimeout);
      // Deadline starts after the actual stage is ready, independent of suite scheduling.
      if (timed) cancellationTimeout = setTimeout(() => cancel.abort(), 30);
      else cancel.abort();
      await stopped;
      assert.throws(
        () => process.kill(processInfo.pid, 0),
        (error: NodeJS.ErrnoException) => error.code === 'ESRCH',
      );
      await assert.rejects(
        stat(processInfo.classes),
        (error: NodeJS.ErrnoException) => error.code === 'ENOENT',
      );
    } finally {
      clearTimeout(readinessTimeout);
      clearTimeout(cancellationTimeout);
      cancel.abort();
      await stopped;
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      if (prior === undefined) delete process.env.BOOPY_PROBE_JDK;
      else process.env.BOOPY_PROBE_JDK = prior;
    }
  });
}

test('explicit catalog pairs and fresh identities are bounded', async () => {
  for (const [conceptKey, referenceId] of [
    ['dune', 'Q25391'],
    ['desert', 'Q8514'],
    ['dromedary', 'Q71516'],
  ])
    assert.equal(ZetarisReferenceAssociation.safeParse({ conceptKey, referenceId }).success, true);
  assert.equal(
    ZetarisReferenceAssociation.safeParse({ conceptKey: 'dune', referenceId: 'Q8514' }).success,
    false,
  );
  assert.equal(
    ZetarisReferenceAssociation.safeParse({ conceptKey: 'camel', referenceId: 'Q71516' }).success,
    false,
  );
  await fixture(async (credentialFile) => {
    for (const referenceId of ['Q8514', 'Q71516']) {
      const row = {
        ...result.rows[0],
        referenceId,
        referenceSourceId: `wikidata:${referenceId}`,
        referenceUrl: `https://www.wikidata.org/wiki/${referenceId}`,
      };
      await lookupZetarisReference({ referenceId, credentialFile }, async (request) => {
        assert.equal(request.referenceId, referenceId);
        return { ...result, rows: [row] };
      });
      await assert.rejects(
        lookupZetarisReference({ referenceId, credentialFile }, async () => result),
      );
    }
    await assert.rejects(
      lookupZetarisReference({ referenceId: "Q8514' OR 1=1", credentialFile }, async () => result),
    );
  });
});

test('fixed failure phases preserve generic text and never vendor diagnostics', async () => {
  await fixture(async (credentialFile, directory) => {
    await assert.rejects(
      lookupZetarisReference({ referenceId: 'unsupported', credentialFile }),
      (error: unknown) => error instanceof ZetarisReferenceError && error.phase === 'input',
    );
    await assert.rejects(
      lookupZetarisReference({ referenceId: 'Q25391', credentialFile: join(directory, 'missing') }),
      (error: unknown) => error instanceof ZetarisReferenceError && error.phase === 'credentials',
    );
    await assert.rejects(
      lookupZetarisReference({ referenceId: 'Q25391', credentialFile }, async () => ({})),
      (error: unknown) => error instanceof ZetarisReferenceError && error.phase === 'result',
    );
    const bin = join(directory, 'jdk', 'bin');
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, 'javac'), `#!${process.execPath}\nprocess.exit(0);\n`, {
      mode: 0o700,
    });
    const prior = process.env.BOOPY_PROBE_JDK;
    process.env.BOOPY_PROBE_JDK = join(directory, 'jdk');
    try {
      for (const stage of ['connect', 'reference', 'private-password']) {
        const receipt = {
          syntheticContext: true,
          outcome: 'failed',
          stage,
          failureKind: 'unclassified',
          signals: [],
          errorClass: 'SQLException',
          private: 'vendor-password',
        };
        await writeFile(
          join(bin, 'java'),
          `#!${process.execPath}\nconsole.log(${JSON.stringify(JSON.stringify(receipt))});process.exit(1);\n`,
          { mode: 0o700 },
        );
        await assert.rejects(
          lookupZetarisReference({ referenceId: 'Q25391', credentialFile }),
          (error: unknown) => {
            assert.ok(error instanceof ZetarisReferenceError);
            assert.equal(error.phase, stage === 'private-password' ? 'subprocess' : stage);
            assert.equal(error.message, 'Zetaris reference unavailable.');
            assert.doesNotMatch(JSON.stringify(error), /private|vendor|password/);
            return true;
          },
        );
      }
    } finally {
      if (prior === undefined) delete process.env.BOOPY_PROBE_JDK;
      else process.env.BOOPY_PROBE_JDK = prior;
    }
  });
});
