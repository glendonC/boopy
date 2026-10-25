import type { Box, ItemStatus, Point } from '../contracts.ts';
import type { TextLine } from '../events.ts';
import type { ModelOutput } from './output.ts';

/** Everything a model is shown for one utterance. */
export interface InterpretInput {
  readonly said: string;
  readonly inputSource?: 'speech' | 'typed' | 'suggestion' | 'choice';
  /** Up to six prior turns, supplied from journal provenance, never verified model truth. */
  readonly conversation?: readonly {
    readonly speaker: 'person' | 'boopy';
    readonly text: string;
    readonly utteranceId: string;
    readonly observationId: string | null;
    readonly inputSource?: 'speech' | 'typed' | 'suggestion' | 'choice';
  }[];
  /** Up to eight actual existing items; selection does not confirm their claims. */
  readonly contextualItems?: readonly {
    readonly id: string;
    readonly kind: string;
    readonly label: string;
    readonly statement: string;
    readonly status: ItemStatus;
    readonly origin: 'model' | 'person';
    readonly confidence: number | null;
    readonly note?: string;
  }[];
  readonly sourceContext?: {
    readonly source: string;
    /** Null when a recorded file gives no capture time. */
    readonly capturedAt: string | null;
    readonly timestampTrusted: boolean;
    readonly selectionReason: string;
    /** Set for a frame of the person's recording: its time in the file, null for a photo. */
    readonly recorded?: { readonly seconds: number | null };
  };
  /** An explicit recorded reference, not a recognition of a currently visible physical object. */
  readonly selectedReference?: {
    readonly itemId: string;
    readonly observationId: string;
    readonly label: string;
    readonly statement: string;
    readonly verification: 'accepted' | 'confirmed' | 'authored' | 'corrected';
    readonly disposition: ItemStatus;
    readonly confidence: number | null;
    readonly box: Box | null;
    readonly text: readonly string[];
    readonly note?: string;
  };
  readonly language: string;
  readonly scope: 'auto' | 'scene';
  readonly gaze: Point | null;
  readonly pointer: Point | null;
  /** The frame with the cue markers drawn, as JPEG. */
  readonly image: Buffer;
  /** A full-resolution close-up around the main cue, as JPEG, and where it sits in the frame. */
  readonly crop: { readonly image: Buffer; readonly region: Box } | null;
  readonly text: readonly TextLine[];
  readonly decisions: readonly {
    readonly label: string;
    readonly status: ItemStatus;
    readonly note?: string;
  }[];
}

export interface InterpretResult {
  readonly output: ModelOutput;
  /** The model's own answer, kept in the journal for audit. */
  readonly raw: string;
}

/** A model that proposes an interpretation. Adapters convert their grids to Boopy's. */
export interface Interpreter {
  readonly provider: string;
  readonly model: string;
  interpret(input: InterpretInput, signal?: AbortSignal): Promise<InterpretResult>;
}

/** Sanitized transport refusal; carries no host, request text or vendor response. */
export class InterpreterUnavailableError extends Error {
  constructor() {
    super('Local interpreter connection unavailable.');
  }
}
