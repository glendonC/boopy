import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderSelectedSupplement, type SelectedSupplement } from './handoff-supplement.ts';

test('direct renderer validates semantic provenance and rejects vectors or invented available models', () => {
  const base: SelectedSupplement = {
    synthetic: true,
    baselinePackageId: 'ctx_synthetic',
    selectedPackageIds: ['ctx_synthetic'],
    memory: { mode: 'hmem-subset', hits: [], constraints: [], openQuestions: [] },
    references: { mode: 'disabled', rows: [] },
  };
  const valid = {
    status: 'available' as const,
    provider: 'nvidia' as const,
    model: 'nvidia/nemotron-3-embed-1b',
    revision: 'c0c9fea93ea424587517f2c59e20db9f1d6bf615',
  };
  assert.match(
    renderSelectedSupplement({ ...base, memory: { ...base.memory, semantic: valid } }),
    /not verification/,
  );
  for (const semantic of [
    { ...valid, model: 'invented' },
    { ...valid, revision: undefined },
    { ...valid, vectors: [1, 2] },
    { status: 'unavailable', provider: 'nvidia', model: 'invented' },
  ])
    assert.throws(() =>
      renderSelectedSupplement({
        ...base,
        memory: { ...base.memory, semantic },
      } as SelectedSupplement),
    );
});

test('supplement headings use no em dash, synthetic or not', () => {
  const emDash = String.fromCharCode(0x2014);
  for (const synthetic of [true, false]) {
    const text = renderSelectedSupplement({
      synthetic,
      baselinePackageId: 'ctx_synthetic',
      selectedPackageIds: ['ctx_synthetic'],
      memory: { mode: 'disabled', hits: [], constraints: [], openQuestions: [] },
      references: { mode: 'disabled', rows: [] },
    });
    assert.equal(text.includes(emDash), false);
    assert.deepEqual(text.split('\n').slice(0, 2), [
      synthetic
        ? 'SYNTHETIC REHEARSAL: FICTIONAL, NOT PERSONAL HISTORY.'
        : 'SELECTED BOOPY CONTEXT: use only within the chosen task.',
      'OPTIONAL SELECTED CONTEXT SUPPLEMENT, separate from the immutable Boopy package.',
    ]);
  }
});
