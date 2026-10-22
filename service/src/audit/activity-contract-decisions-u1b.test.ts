/** Audit tests on U1b that wait for a lead decision before they bind the backend. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  displayText,
  readContainer,
  snapValue,
  validateActivityBody,
} from '../activity-contract.ts';

test('audit U1b decision: decimal-valid price axes are not lost to binary rounding', () => {
  // Each axis has at most 6 decimals, |value| at most 1e9 and a whole number of steps in decimal,
  // but (max - min) / step in doubles misses a whole number by more than 1e-9.
  for (const text of [
    '{"min":999999.99,"max":1000000.06,"step":0.01}',
    '{"min":1234567.89,"max":1234568.24,"step":0.05}',
    '{"min":1234567.89,"max":1234568.59,"step":0.1}',
    '{"min":123456.78,"max":123456.88,"step":0.001}',
  ]) {
    const axis = readContainer(text)?.value as { min: number; max: number; step: number };
    const result = validateActivityBody(
      {
        title: 'Synthetic price',
        purpose: 'Synthetic.',
        instruction: { text: 'Place your estimate.', language: 'en' },
        components: [
          {
            type: 'arrange',
            axis: { kind: 'number', ...axis },
            tokens: [{ key: 'a', label: { text: 'Price', language: 'en' }, sourceId: null }],
          },
        ],
      },
      new Set(),
    );
    assert.deepEqual(result.issues, [], text);
    assert.equal(snapValue(axis, 1), axis.max, text);
  }
});

test('audit U1b decision: a scheme word followed by a space is not a link', () => {
  for (const value of ['Mobile data: 5 GB', 'Tel: 0522 12 34 56', 'SMS: send YES to confirm'])
    assert.equal(displayText(200).safeParse(value).success, true, value);
  for (const value of ['data:text/plain,x', 'tel:+212522123456', 'sms:+212600000000'])
    assert.equal(displayText(200).safeParse(value).success, false, value);
});
