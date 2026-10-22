import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { NvidiaEmbeddingWorker } from './nvidia.ts';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'boopy-embedding-'));
  const script = join(directory, 'worker.mjs');
  const starts = join(directory, 'starts');
  await writeFile(
    script,
    `
import {appendFileSync} from 'node:fs';
import {createInterface} from 'node:readline';
appendFileSync(${JSON.stringify(starts)}, 'start\\n');
const emit=x=>console.log(JSON.stringify(x));
const vector=()=>Array.from({length:2048},(_,i)=>i===0?1:0);
emit({type:'ready',model:'nvidia/nemotron-3-embed-1b',revision:'c0c9fea93ea424587517f2c59e20db9f1d6bf615',dimension:2048});
for await(const line of createInterface({input:process.stdin})) {
 const r=JSON.parse(line);
 if(r.query==='timeout')continue;
 if(r.query==='crash')process.exit(1);
 if(r.query==='malformed'){console.log('PRIVATE_INVALID_TEXT');continue;}
 if(r.query==='too_long'){emit({type:'error',id:r.id,code:'too_long'});continue;}
 if(r.query==='error'){console.error('PRIVATE_PROVIDER_TEXT');emit({type:'error',id:r.id,code:'inference_failed'});continue;}
 emit({type:'result',id:r.query==='bad-id'?'wrong':r.id,
 query:r.query==='zero'?Array(2048).fill(0):r.query==='dimension'?[1]:vector(),
 passages:r.candidates.map((c,i)=>({sourceId:r.query==='substitute'?'alien':c.sourceId,embedding:vector().map(v=>i===0?v:-v)}))});
}
`,
  );
  const worker = new NvidiaEmbeddingWorker({
    pythonPath: process.execPath,
    modelDirectory: directory,
    scriptPath: script,
    device: 'cpu',
    timeoutMs: 100,
    startupTimeoutMs: 2000,
  });
  return {
    worker,
    starts,
    async dispose() {
      worker.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
const candidates = [
  { sourceId: 'selected-a', text: 'Synthetic tea.' },
  { sourceId: 'selected-b', text: 'Synthetic boat.' },
];

test('persistent local worker ranks only supplied IDs, returns bounded raw scores and reuses process', async () => {
  const f = await fixture();
  try {
    const first = await f.worker.rank({ query: 'tea', candidates });
    assert.deepEqual(first.candidates, [
      { sourceId: 'selected-a', score: 1 },
      { sourceId: 'selected-b', score: -1 },
    ]);
    assert.equal(first.model, 'nvidia/nemotron-3-embed-1b');
    await f.worker.rank({ query: '차', candidates });
    assert.equal(await readFile(f.starts, 'utf8'), 'start\n');
  } finally {
    await f.dispose();
  }
});

test('request limits reject before worker starts without exposing selected content', async () => {
  const f = await fixture();
  try {
    for (const input of [
      { query: 'x'.repeat(501), candidates },
      { query: 'tea', candidates: Array(21).fill(candidates[0]) },
      { query: 'tea', candidates: [candidates[0], candidates[0]] },
    ]) {
      await assert.rejects(
        f.worker.rank(input),
        (error: Error) => !error.message.includes('Synthetic'),
      );
    }
    await assert.rejects(readFile(f.starts));
  } finally {
    await f.dispose();
  }
});

for (const query of [
  'bad-id',
  'dimension',
  'zero',
  'substitute',
  'malformed',
  'error',
  'too_long',
  'crash',
  'timeout',
]) {
  test(`worker fails closed and can restart after ${query}`, async () => {
    const f = await fixture();
    try {
      await assert.rejects(
        f.worker.rank({ query, candidates }),
        (error: Error) =>
          !error.message.includes('PRIVATE') && !error.message.includes('Synthetic'),
      );
      assert.equal((await f.worker.rank({ query: 'tea', candidates })).candidates.length, 2);
      assert.equal((await readFile(f.starts, 'utf8')).split('start\n').length - 1, 2);
    } finally {
      await f.dispose();
    }
  });
}

test('cancellation kills pending worker, refuses concurrent work and allows clean restart', async () => {
  const f = await fixture();
  try {
    const controller = new AbortController();
    const pending = f.worker.rank({ query: 'timeout', candidates, signal: controller.signal });
    await assert.rejects(f.worker.rank({ query: 'tea', candidates }), /busy/);
    controller.abort();
    await assert.rejects(pending, /cancelled/);
    await f.worker.rank({ query: 'tea', candidates });
    f.worker.close();
    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(
      f.worker.rank({ query: 'tea', candidates, signal: aborted.signal }),
      /cancelled/,
    );
  } finally {
    await f.dispose();
  }
});
