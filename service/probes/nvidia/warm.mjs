/** Synthetic-only warm-worker evaluation; never loads a Boopy journal. */
import { performance } from 'node:perf_hooks';
import { NvidiaEmbeddingWorker } from '../../src/memory/nvidia.ts';

const [pythonPath, modelDirectory] = process.argv.slice(2);
if (!pythonPath || !modelDirectory)
  throw new Error('Provide isolated Python and pinned local model paths.');
const worker = new NvidiaEmbeddingWorker({
  pythonPath,
  modelDirectory,
  device: 'mps',
  timeoutMs: 30000,
});
const candidates = [
  {
    sourceId: 'morning',
    text: 'Synthetic travel note: I walked across the dunes before noon. I did not ride an animal.',
  },
  { sourceId: 'sunset', text: '합성 여행 메모: 저는 해 질 무렵 낙타를 타지 않고 사구를 걸었어요.' },
  { sourceId: 'rode', text: 'Synthetic travel note: I rode a camel over the dunes at sunset.' },
  { sourceId: 'tea', text: 'Synthetic cafe note: I ordered green tea without milk.' },
  { sourceId: 'milk', text: 'Synthetic cafe note: I ordered black tea with milk.' },
  { sourceId: 'boat', text: 'Synthetic harbor note: The blue boat left the dock at dawn.' },
];
const cases = [
  ['Which note says I walked on dunes at sunset without riding a camel?', 'sunset'],
  ['Where did I walk on sand before midday without riding?', 'morning'],
  ['우유 없이 녹차를 주문한 메모는?', 'tea'],
  ['Which note describes riding a camel at sunset?', 'rode'],
  ['새벽에 항구를 떠난 파란 배는?', 'boat'],
];
try {
  const results = [];
  for (const [query, expected] of cases) {
    const start = performance.now();
    const result = await worker.rank({ query, candidates });
    results.push({
      query,
      expected,
      elapsedMs: Math.round(performance.now() - start),
      rank: result.candidates.findIndex((x) => x.sourceId === expected) + 1,
      candidates: result.candidates,
    });
  }
  const start = performance.now();
  let tokenLimitRejected = false;
  try {
    await worker.rank({
      query: 'Synthetic token boundary',
      candidates: [{ sourceId: 'long', text: 'synthetic '.repeat(700) }],
    });
  } catch (error) {
    tokenLimitRejected = error.message === 'Selected text exceeds local embedding token limit.';
  }
  console.log(
    JSON.stringify(
      {
        syntheticOnly: true,
        model: 'nvidia/nemotron-3-embed-1b',
        results,
        tokenLimitRejected,
        tokenCheckMs: Math.round(performance.now() - start),
      },
      null,
      2,
    ),
  );
} finally {
  worker.close();
}
