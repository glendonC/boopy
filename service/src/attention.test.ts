import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type AttentionRequest, decideAttention } from './attention.ts';

const currentObservation = {
  id: 'synthetic-view',
  source: 'current-surroundings' as const,
  capturedAtMs: 950,
  timestampTrusted: true,
};
const base: AttentionRequest = {
  utterance: 'The whole view felt colder than expected.',
  scope: 'scene',
  evidence: 'visual',
  source: 'current-surroundings',
  ambiguousTarget: false,
  ocrRequested: false,
  segmentationRequested: false,
  nowMs: 1000,
  maxAgeMs: 100,
  observation: {
    id: 'synthetic-view',
    source: 'current-surroundings',
    capturedAtMs: 950,
    timestampTrusted: true,
  },
};

describe('explicit-request attention policy', () => {
  it('preserves typed scene speech and avoids unrequested OCR/segmentation', () => {
    const result = decideAttention(base);
    assert.equal(result.action, 'reuse');
    assert.equal(result.utterance, base.utterance);
    assert.equal(result.observationId, 'synthetic-view');
    assert.deepEqual(result.work, { ocr: false, segmentation: false });
  });
  it('does no perception for a request with no visual evidence need', () => {
    const result = decideAttention({
      ...base,
      evidence: 'none',
      ocrRequested: true,
      segmentationRequested: true,
    });
    assert.equal(result.action, 'no-visual-work');
    assert.deepEqual(result.work, { ocr: false, segmentation: false });
  });
  it('clarifies ambiguous targets and unknown sources', () => {
    assert.equal(
      decideAttention({ ...base, scope: 'target', ambiguousTarget: true }).action,
      'clarify',
    );
    assert.equal(decideAttention({ ...base, source: 'unknown' }).action, 'clarify');
  });
  it('requests a matching fresh view for absent, stale, future or untrusted observations', () => {
    const missing = { ...base };
    delete missing.observation;
    assert.equal(decideAttention(missing).action, 'fresh-view');
    for (const capturedAtMs of [null, 899, 1001, Number.NaN])
      assert.equal(
        decideAttention({ ...base, observation: { ...currentObservation, capturedAtMs } }).action,
        'fresh-view',
      );
    assert.equal(
      decideAttention({ ...base, observation: { ...currentObservation, timestampTrusted: false } })
        .action,
      'fresh-view',
    );
    assert.equal(decideAttention({ ...base, source: 'virtual-scene' }).action, 'fresh-view');
    assert.equal(decideAttention({ ...base, source: 'displayed-image' }).action, 'fresh-view');
  });
  it('does not mistake current surroundings for an absent past experience', () => {
    assert.equal(decideAttention({ ...base, source: 'past-recollection' }).action, 'clarify');
    const historical = {
      ...base,
      source: 'past-recollection' as const,
      observation: {
        id: 'past-view',
        source: 'past-recollection' as const,
        capturedAtMs: 1,
        timestampTrusted: true,
      },
    };
    assert.equal(decideAttention(historical).action, 'reuse');
    for (const nowMs of [Number.NaN, Infinity, -Infinity])
      assert.equal(decideAttention({ ...historical, nowMs }).action, 'clarify');
    assert.equal(
      decideAttention({
        ...historical,
        observation: { ...historical.observation, capturedAtMs: historical.nowMs + 1 },
      }).action,
      'clarify',
    );
    assert.equal(
      decideAttention({
        ...historical,
        observation: { ...historical.observation, capturedAtMs: historical.nowMs },
      }).action,
      'reuse',
    );
    assert.equal(
      decideAttention({
        ...historical,
        observation: { ...historical.observation, capturedAtMs: null },
      }).action,
      'clarify',
    );
  });
  it('uses caller freshness limits and only schedules explicitly requested evidence work', () => {
    assert.equal(decideAttention({ ...base, maxAgeMs: 49 }).action, 'fresh-view');
    assert.equal(decideAttention({ ...base, maxAgeMs: 50 }).action, 'reuse');
    assert.equal(decideAttention({ ...base, maxAgeMs: -1 }).action, 'clarify');
    assert.equal(decideAttention({ ...base, nowMs: Number.NaN }).action, 'clarify');
    assert.deepEqual(decideAttention({ ...base, ocrRequested: true }).work, {
      ocr: true,
      segmentation: false,
    });
    assert.deepEqual(decideAttention({ ...base, segmentationRequested: true }).work, {
      ocr: false,
      segmentation: true,
    });
  });
  it('inspects a supplied known-source view without upgrading its unknown sensor time', () => {
    const supplied = {
      ...base,
      observation: {
        ...currentObservation,
        capturedAtMs: null,
        timestampTrusted: false,
        suppliedForTurn: true,
      },
    };
    const result = decideAttention(supplied);
    assert.equal(result.action, 'reuse');
    assert.match(result.reason, /not proof.*current scene or capture time/);
    assert.equal(supplied.observation.timestampTrusted, false);
    assert.equal(
      decideAttention({
        ...supplied,
        observation: { ...supplied.observation, suppliedForTurn: false },
      }).action,
      'fresh-view',
    );
    assert.equal(decideAttention({ ...supplied, source: 'unknown' }).action, 'clarify');
    assert.equal(
      decideAttention({
        ...supplied,
        source: 'past-recollection',
        observation: { ...supplied.observation, source: 'past-recollection' },
      }).action,
      'reuse',
    );
    assert.equal(
      decideAttention({
        ...supplied,
        observation: {
          ...supplied.observation,
          timestampTrusted: true,
          capturedAtMs: base.nowMs + 1,
        },
      }).action,
      'clarify',
    );
  });
});
