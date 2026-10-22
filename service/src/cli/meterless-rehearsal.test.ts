import assert from 'node:assert/strict';
import { test } from 'node:test';
import { meterlessRehearsal } from './meterless-rehearsal.ts';

test('actual pinned H-MEM REST/MCP rehearsal preserves corrections, selection, trust and optional core independence', async () => {
  const result = await meterlessRehearsal();
  assert.equal(result.passed, true);
  assert.ok(result.englishHits > 0 && result.koreanHits > 0);
  assert.equal(result.correctionMetadataExact, true);
  assert.equal(result.disabledCoreRead, true);
});
