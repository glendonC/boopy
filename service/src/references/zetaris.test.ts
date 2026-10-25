import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { TermRow, TermSnapshot } from './wikidata.ts';
import {
  lookupZetarisReference,
  pickTerm,
  stagePractice,
  ZetarisPracticeError,
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

const PRACTICE_USER = 'boopy-practice-1970-01-01@example.invalid';
async function practiceFixture(work: (path: string, directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'boopy-practice-test-'));
  const path = join(directory, 'credentials');
  try {
    await writeFile(path, `${PRACTICE_USER}\nsynthetic-only-password\n`, { mode: 0o600 });
    await work(path, directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
const practiceRow = {
  attemptId: 'evt_synthetic_1',
  taskId: 'tsk_synthetic_1',
  sourceId: 'src_synthetic_1',
  referenceId: 'Q7375',
  language: 'ko',
  result: 'not-heard',
  recognitionUncertain: true,
  attemptedAt: '1970-01-01T00:00:01.000Z',
} as const;
const pickRequest = {
  table: 'practice_check',
  targetLanguage: 'ko',
  personLanguage: 'en',
  matchKey: 'synthetic animal',
  sourceId: 'src_synthetic_1',
  recalled: ['Q25391'],
  excluded: ['tsk_synthetic_0'],
  rows: [practiceRow],
} as const;
const picked = {
  referenceId: 'Q7375',
  matched: 'subject',
  matchedText: 'Synthetic Animal',
  term: '합성어',
  gloss: null,
  description: 'synthetic description',
  referenceSourceId: 'wikidata:Q7375',
  revisionId: '101',
  modifiedAt: '1970-01-01T00:00:00Z',
  retrievedAt: '1970-01-01T00:00:02.000Z',
  referenceUrl: 'https://www.wikidata.org/wiki/Q7375',
  license: 'CC0-1.0',
  status: 'external-unreviewed',
  attempts: 1,
  notHeard: 1,
  onSource: 1,
  lastAt: '1970-01-01T00:00:01.000Z',
  lastResult: 'not-heard',
  why: 'not-heard-before',
};
const recalledRow = {
  ...picked,
  referenceId: 'Q25391',
  matched: 'recalled',
  matchedText: null,
  referenceSourceId: 'wikidata:Q25391',
  referenceUrl: 'https://www.wikidata.org/wiki/Q25391',
  attempts: 0,
  notHeard: 0,
  onSource: 0,
  lastAt: null,
  lastResult: null,
  why: 'new',
};
const pickResult = {
  mode: 'zetaris-runtime',
  operation: 'term-pick-check',
  practice: { tableRows: 1, journalRows: 1, restaged: false },
  stageMs: 1,
  pickMs: 2,
  rows: [picked, recalledRow],
};
/** The synthetic import the rows above come from, as Boopy keeps it outside Zetaris. */
const termRow = (
  referenceId: string,
  language: string,
  kind: string,
  text: string,
  key = '',
): TermRow => ({
  source_id: `wikidata:${referenceId}`,
  reference_id: referenceId,
  language,
  kind,
  text,
  match_key: key,
  revision_id: '101',
  modified_at: '1970-01-01T00:00:00Z',
  retrieved_at: '1970-01-01T00:00:02.000Z',
  reference_url: `https://www.wikidata.org/wiki/${referenceId}`,
  license: 'CC0-1.0',
  status: 'external-unreviewed',
});
const snapshot: TermSnapshot = {
  rows: [
    termRow('Q7375', 'en', 'alias', 'Synthetic Animal', 'synthetic animal'),
    termRow('Q7375', 'en', 'description', 'synthetic description'),
    termRow('Q7375', 'ko', 'label', '합성어'),
    termRow('Q25391', 'en', 'description', 'synthetic description'),
    termRow('Q25391', 'ko', 'label', '합성어'),
  ],
  fileSha256: 'a'.repeat(64),
};
const pickOptions = (credentialFile: string) => ({
  request: pickRequest,
  credentialFile,
  snapshot,
});

test('a term pick sends fixed request lines and the credential path, nothing else', async () => {
  await practiceFixture(async (path) => {
    const returned = await pickTerm(pickOptions(path), async (call) => {
      assert.deepEqual(Object.keys(call).sort(), ['credentialFile', 'input', 'mode', 'signal']);
      assert.equal(call.mode, 'term-pick-check');
      assert.equal(
        call.input,
        [
          'pick\tko\ten\tsynthetic animal\tsrc_synthetic_1',
          'recall\tQ25391',
          'exclude\ttsk_synthetic_0',
          'row\tevt_synthetic_1\ttsk_synthetic_1\tsrc_synthetic_1\tQ7375\tko\tnot-heard\ttrue\t1970-01-01T00:00:01.000Z',
          'end',
          '',
        ].join('\n'),
      );
      return pickResult;
    });
    assert.deepEqual(returned, pickResult);
    const staged = await stagePractice(
      { table: 'practice_attempt', rows: [practiceRow], credentialFile: path },
      async (call) => {
        assert.equal(call.mode, 'practice-stage');
        assert.equal(call.input.split('\n')[0]?.startsWith('row\t'), true);
        return {
          mode: 'zetaris-runtime',
          operation: 'practice-stage',
          practice: { tableRows: 0, journalRows: 1, restaged: true },
          stageMs: 3,
        };
      },
    );
    assert.deepEqual(staged.practice, { tableRows: 0, journalRows: 1, restaged: true });
  });
});

test('a value that could change the fixed query, or a wrong credential, fails before any call', async () => {
  await practiceFixture(async (path, directory) => {
    let calls = 0;
    const execute = async () => {
      calls++;
      return pickResult;
    };
    for (const request of [
      { ...pickRequest, matchKey: "camel' OR '1'='1" },
      { ...pickRequest, matchKey: 'tab\there' },
      { ...pickRequest, matchKey: 'x'.repeat(81) },
      { ...pickRequest, targetLanguage: 'korean' },
      { ...pickRequest, sourceId: 'src_bad id' },
      { ...pickRequest, recalled: ['Q0'] },
      { ...pickRequest, recalled: Array.from({ length: 9 }, (_, n) => `Q${n + 1}`) },
      { ...pickRequest, excluded: ['task'] },
      { ...pickRequest, table: 'wikidata_term' },
      { ...pickRequest, rows: [{ ...practiceRow, attemptedAt: '1970-01-01T00:00:01+01:00' }] },
      { ...pickRequest, rows: [{ ...practiceRow, result: 'right' }] },
      { ...pickRequest, rows: [{ ...practiceRow, text: '낙타가 있어요' }] },
      { ...pickRequest, rows: Array.from({ length: 501 }, () => practiceRow) },
      { ...pickRequest, sql: 'SELECT 1' },
    ])
      await assert.rejects(
        pickTerm({ ...pickOptions(path), request }, execute),
        (error: unknown) => error instanceof ZetarisPracticeError && error.phase === 'input',
      );
    await writeFile(path, 'boopy-reference-1970-01-01@example.invalid\nsynthetic-only-password\n');
    await assert.rejects(pickTerm(pickOptions(path), execute));
    await writeFile(path, `${PRACTICE_USER}\nsynthetic-only-password\n`);
    await chmod(path, 0o644);
    await assert.rejects(pickTerm(pickOptions(path), execute));
    await chmod(path, 0o600);
    const alias = join(directory, 'alias');
    await symlink(path, alias);
    await assert.rejects(pickTerm(pickOptions(alias), execute));
    assert.equal(calls, 0);
  });
});

test('a pick result that breaks identity, order, counts or the request fails with no substitute', async () => {
  await practiceFixture(async (path) => {
    const options = pickOptions(path);
    for (const raw of [
      { ...pickResult, extra: true },
      { ...pickResult, operation: 'term-pick' },
      { ...pickResult, rows: [{ ...picked, license: 'guessed' }] },
      { ...pickResult, rows: [{ ...picked, status: 'confirmed' }] },
      { ...pickResult, rows: [{ ...picked, referenceUrl: 'https://example.invalid/Q7375' }] },
      { ...pickResult, rows: [{ ...picked, notHeard: 2 }] },
      { ...pickResult, rows: [{ ...picked, why: 'right' }] },
      { ...pickResult, rows: [{ ...picked, matchedText: 'Another Animal' }] },
      { ...pickResult, rows: [recalledRow, picked] },
      { ...pickResult, rows: [picked, picked] },
      { ...pickResult, rows: [{ ...recalledRow, referenceId: 'Q8514' }] },
      { ...pickResult, practice: { tableRows: 1, journalRows: 2, restaged: false } },
      { ...pickResult, rows: Array.from({ length: 10 }, () => recalledRow) },
    ])
      await assert.rejects(
        pickTerm(options, async () => raw),
        (error: unknown) => {
          assert.equal(error instanceof ZetarisPracticeError && error.phase, 'result');
          assert.equal(String(error), 'Error: Zetaris practice unavailable.');
          return true;
        },
      );
  });
});

test('every pick row is checked against the import kept outside Zetaris; a mismatch is its own phase', async () => {
  await practiceFixture(async (path) => {
    const options = pickOptions(path);
    for (const rows of [
      [{ ...picked, term: '바뀐말' }, recalledRow],
      [{ ...picked, description: 'changed' }, recalledRow],
      [{ ...picked, gloss: 'invented gloss' }, recalledRow],
      [{ ...picked, revisionId: '102' }, recalledRow],
      [{ ...picked, retrievedAt: '1970-01-01T00:00:03.000Z' }, recalledRow],
      [picked, { ...recalledRow, term: null }],
      [recalledRow],
      [picked],
      [],
    ])
      await assert.rejects(
        pickTerm(options, async () => ({ ...pickResult, rows })),
        (error: unknown) => {
          assert.equal(error instanceof ZetarisPracticeError && error.phase, 'integrity');
          return true;
        },
      );
  });
});

test('practice failures keep a fixed phase, never vendor text, and a cancelled pick never returns', async () => {
  await practiceFixture(async (path) => {
    const options = pickOptions(path);
    await assert.rejects(
      pickTerm(options, async () => {
        throw new ZetarisPracticeError('connect');
      }),
      (error: unknown) => error instanceof ZetarisPracticeError && error.phase === 'connect',
    );
    await assert.rejects(
      pickTerm(options, async () => {
        throw new Error('synthetic-private vendor detail');
      }),
      (error: unknown) => {
        assert.equal(error instanceof ZetarisPracticeError && error.phase, 'subprocess');
        assert.doesNotMatch(String(error), /synthetic-private/);
        return true;
      },
    );
    const cancel = new AbortController();
    await assert.rejects(
      pickTerm({ ...options, signal: cancel.signal }, async () => {
        cancel.abort();
        return pickResult;
      }),
      /cancelled/,
    );
  });
});

test('every write statement in the runner names one of the two practice tables as a constant', async () => {
  const source = await readFile(
    fileURLToPath(new URL('../../probes/zetaris/JdbcFederation.java', import.meta.url)),
    'utf8',
  );
  const writes = [...source.matchAll(/"INSERT (?:OVERWRITE TABLE|INTO) "\s*\+\s*([A-Za-z_]+)/g)];
  assert.ok(writes.length >= 4);
  for (const [, table] of writes) assert.match(table ?? '', /^(ATTEMPTS|CHECKS)$/);
  assert.equal((source.match(/INSERT (?:OVERWRITE|INTO)/g) ?? []).length, writes.length);
  assert.match(source, /ATTEMPTS = "BOOPY_PRACTICE\.practice_attempt"/);
  assert.match(source, /CHECKS = "BOOPY_PRACTICE\.practice_check"/);
  assert.doesNotMatch(source, /\b(DELETE|DROP|TRUNCATE) /);
});
