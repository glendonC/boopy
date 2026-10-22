/** Explicit synthetic NVIDIA evaluation only. Never imports production config or context. */
import { lstat, open, readFile } from 'node:fs/promises';
import { evaluateVectors, metrics, model, requests } from './evaluate.mjs';
export async function runSynthetic({ credentialFile, output, fetcher = fetch }) {
  const info = await lstat(credentialFile);
  if (!info.isFile() || info.mode & 0o077 || info.size > 4096)
    throw new Error('Choose a private bounded API-key file.');
  const token = (await readFile(credentialFile, 'utf8')).trim();
  if (!token || /\s/.test(token)) throw new Error('Invalid API-key file.');
  const plan = requests();
  const vectors = [];
  const latency = [];
  for (const body of plan.bodies) {
    const start = performance.now();
    const response = await fetcher(plan.endpoint, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error(`NVIDIA trial request failed (${response.status}); no fallback or retry.`);
    }
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 2 * 1024 * 1024) throw new Error('Oversized NVIDIA result.');
        chunks.push(chunk.value);
      }
    } catch (error) {
      await reader.cancel();
      throw error;
    } finally {
      reader.releaseLock();
    }
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (
      parsed.model !== model ||
      !Array.isArray(parsed.data) ||
      parsed.data.length !== body.input.length
    )
      throw new Error('Unexpected NVIDIA response identity/count.');
    const ordered = [...parsed.data].sort((a, b) => a.index - b.index);
    if (!ordered.every((entry, index) => entry.index === index))
      throw new Error('Unexpected embedding ordering.');
    vectors.push(ordered.map((entry) => entry.embedding));
    latency.push(performance.now() - start);
  }
  const receipt = {
    synthetic: true,
    model,
    passageSources: plan.passageSources,
    queryIds: plan.queryIds,
    passages: vectors[0],
    queries: vectors[1],
    provider: 'nvidia-integrate-api',
    capturedAt: new Date().toISOString(),
    latencyMs: latency,
  };
  const evaluation = metrics(evaluateVectors(receipt));
  const file = await open(output, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(receipt));
    await file.sync();
  } finally {
    await file.close();
  }
  return {
    synthetic: true,
    providerMeasured: true,
    model,
    requests: 2,
    passages: 6,
    queries: 6,
    latencyMs: latency,
    evaluation,
  };
}
if (import.meta.main) {
  try {
    if (process.argv.length !== 4) throw new Error('Choose credential file and new output path.');
    console.log(
      JSON.stringify(
        await runSynthetic({ credentialFile: process.argv[2], output: process.argv[3] }),
        null,
        2,
      ),
    );
  } catch {
    console.error(
      'Synthetic NVIDIA evaluation failed; no key, provider body or context is logged.',
    );
    process.exitCode = 1;
  }
}
