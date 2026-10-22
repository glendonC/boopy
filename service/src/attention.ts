/** One decision per explicit request, never a render-frame perception loop. */
export type AttentionSource =
  | 'current-surroundings'
  | 'displayed-image'
  | 'virtual-scene'
  | 'past-recollection'
  | 'unknown';

export interface AttentionRequest {
  readonly utterance: string;
  readonly scope: 'scene' | 'target';
  readonly evidence: 'none' | 'visual';
  readonly source: AttentionSource;
  readonly ambiguousTarget: boolean;
  readonly ocrRequested: boolean;
  readonly segmentationRequested: boolean;
  /** Caller policy, not an empirical comfort/accuracy measurement. */
  readonly maxAgeMs: number;
  readonly nowMs: number;
  readonly observation?: {
    readonly id: string;
    readonly source: AttentionSource;
    readonly capturedAtMs: number | null;
    readonly timestampTrusted: boolean;
    /** Server-owned: this observation was supplied in this exact request. */
    readonly suppliedForTurn?: boolean;
  };
}

export interface AttentionDecision {
  readonly action: 'no-visual-work' | 'reuse' | 'fresh-view' | 'clarify';
  readonly reason: string;
  readonly utterance: string;
  readonly observationId: string | null;
  readonly work: { readonly ocr: boolean; readonly segmentation: boolean };
}

export function decideAttention(request: AttentionRequest): AttentionDecision {
  const decision = (
    action: AttentionDecision['action'],
    reason: string,
    observationId: string | null = null,
  ): AttentionDecision => ({
    action,
    reason,
    utterance: request.utterance,
    observationId,
    work: {
      ocr: action === 'reuse' && request.ocrRequested,
      segmentation: action === 'reuse' && request.segmentationRequested,
    },
  });
  if (request.evidence === 'none')
    return decision('no-visual-work', 'No visual evidence requested.');
  if (request.source === 'unknown')
    return decision('clarify', 'Identify the intended source first.');
  if (request.scope === 'target' && request.ambiguousTarget)
    return decision('clarify', 'The intended target is ambiguous.');
  if (!Number.isFinite(request.nowMs)) return decision('clarify', 'A valid clock is required.');
  const observation = request.observation;
  if (observation?.source === request.source && observation.suppliedForTurn) {
    if (
      observation.timestampTrusted &&
      observation.capturedAtMs !== null &&
      Number.isFinite(observation.capturedAtMs) &&
      observation.capturedAtMs > request.nowMs
    )
      return decision('clarify', 'The supplied view has a trusted future capture time.');
    return decision(
      'reuse',
      'Inspect the supplied view; this is not proof of the current scene or capture time.',
      observation.id,
    );
  }
  if (request.source === 'past-recollection') {
    // A current camera view cannot establish an absent experience.
    if (observation?.source !== 'past-recollection')
      return decision(
        'clarify',
        'Select evidence of the past experience or continue without visual evidence.',
      );
    if (
      !observation.timestampTrusted ||
      observation.capturedAtMs === null ||
      !Number.isFinite(observation.capturedAtMs)
    )
      return decision('clarify', 'The selected historical source has no trusted capture time.');
    if (observation.capturedAtMs > request.nowMs)
      return decision('clarify', 'The selected historical source has a future capture time.');
    return decision(
      'reuse',
      'Use the selected historical evidence without asserting it is current.',
      observation.id,
    );
  }
  if (!Number.isFinite(request.maxAgeMs) || request.maxAgeMs < 0)
    return decision('clarify', 'A valid clock and explicit freshness policy are required.');
  if (!observation || observation.source !== request.source)
    return decision('fresh-view', 'A view of the intended source is required.');
  if (
    !observation.timestampTrusted ||
    observation.capturedAtMs === null ||
    !Number.isFinite(observation.capturedAtMs)
  )
    return decision('fresh-view', 'The view has no trusted capture time.');
  const age = request.nowMs - observation.capturedAtMs;
  if (age < 0 || age > request.maxAgeMs)
    return decision('fresh-view', 'The view does not satisfy the caller freshness policy.');
  return decision(
    'reuse',
    'The view matches the intended source and freshness policy.',
    observation.id,
  );
}
