/** Hostile activity files. They must fail the checks in docs/activity-contract.md. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readActivityFile, textProblem, validateActivityBody } from '../activity-contract.ts';

test('audit U1: fullwidth angle brackets are rejected like < and >', () => {
  for (const text of ['＜b＞', 'camel ＜ tent', 'tent ＞ camel'])
    assert.notEqual(textProblem(text, 60), null, JSON.stringify(text));
});

test('audit U1: colon schemes are rejected in any case', () => {
  for (const text of [
    'javascript:alert(1)',
    'JavaScript:void(0)',
    'data:text/plain,synthetic',
    'mailto:synthetic@example.invalid',
    'file:synthetic',
    'tel:5550100',
    'SMS:5550100',
    'VBScript:synthetic',
  ])
    assert.notEqual(textProblem(text, 60), null, text);
});

const numberBody = (axis: Record<string, number>) => ({
  title: 'Synthetic estimate',
  purpose: 'Synthetic number axis check.',
  instruction: { text: 'Place your estimate.', language: 'en' },
  components: [
    {
      type: 'arrange',
      axis: { kind: 'number', ...axis },
      tokens: [{ key: 'a', label: { text: 'My estimate', language: 'en' }, sourceId: null }],
    },
  ],
});

test('audit U1: number axis bounds, minimum step and decimals follow section 10a', () => {
  const control = validateActivityBody(numberBody({ min: 0, max: 200, step: 5 }), new Set());
  assert.deepEqual(control.issues, []);
  for (const axis of [
    { min: 0, max: 2e9, step: 2e6 },
    { min: -2e9, max: 0, step: 2e6 },
    { min: 0, max: 0.0005, step: 0.0000005 },
    { min: 0.1234567, max: 1.1234567, step: 0.5 },
    { min: 0, max: 1e300, step: 1e297 },
  ]) {
    const result = validateActivityBody(numberBody(axis), new Set());
    assert.equal(result.activity, null, JSON.stringify(axis));
  }
});

test('audit U1: content that is not well-formed Unicode is unreadable', () => {
  const binding = {
    requestId: 'arq_synthetic1',
    packageId: 'ctx_synthetic1',
    packetSha256: '1'.repeat(64),
  };
  const head = JSON.stringify({
    type: 'boopy.activity',
    version: 1,
    binding,
    fallbackText: 'Synthetic fallback.',
  }).slice(0, -1);
  for (const lone of ['\ud800', '\udfff']) {
    const content = `${head},"activity":{"title":"x${lone}"}}`;
    assert.equal(content.isWellFormed(), false);
    assert.equal(readActivityFile(content).kind, 'unreadable', JSON.stringify(lone));
  }
});
