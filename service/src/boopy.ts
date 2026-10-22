import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { type AttentionDecision, decideAttention } from './attention.ts';
import type {
  ActionRequest,
  AttentionInput,
  Box,
  ChoiceCard,
  ChoiceSelection,
  ContextPackage,
  ContextualAction,
  ContextualActionSelection,
  Cues,
  Frame,
  Item,
  Point,
  SessionView,
  SpatialEvidence,
  Speech,
  SpeechOutputRequest,
  SpeechOutputResponse,
  StartRecoveryView,
  StartSessionRequest,
  UtteranceRequest,
} from './contracts.ts';
import {
  Grounding,
  StartRequestId,
  StartSessionRequest as StartSessionSchema,
} from './contracts.ts';
import type { BoopyEvent, Correction, TextLine, TurnStage } from './events.ts';
import { prepareEvidence } from './evidence.ts';
import {
  type EvidenceRef,
  evidenceRecords,
  evidenceSourceId,
  SupersedeRequest,
  type Supersession,
} from './evidence-contract.ts';
import { type Interpreter, InterpreterUnavailableError } from './interpret/interpreter.ts';
import { choiceForResponse, normalize } from './interpret/output.ts';
import type { Journal, MediaStore, Recorded } from './journal.ts';
import { nearest, type TextReader } from './ocr.ts';
import { buildPackage, verificationOf } from './package.ts';
import {
  MAX_SEGMENT_ITEMS,
  type Segmenter,
  type SegmentResult,
  segmentItems,
} from './segmentation.ts';
import {
  type Observation,
  Projection,
  type SessionState,
  touched,
  utteranceKind,
} from './session.ts';
import type { SpeechEngine } from './speech.ts';
import type { SpeechOutput } from './speech-output.ts';
import { normalize as normalizeWords, type Reading, readUtterance } from './utterance.ts';

/** A refusal the HTTP layer turns into a status code and a line for the person. */
export class BoopyError extends Error {
  override name = 'BoopyError';
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface BoopyDeps {
  readonly journal: Journal;
  readonly media: MediaStore;
  readonly interpreter: Interpreter;
  readonly speech: SpeechEngine | null;
  readonly text: TextReader | null;
  readonly segmenter?: Segmenter | null;
  readonly speechOutput?: SpeechOutput | null;
  readonly service: string;
  readonly now?: () => Date;
  readonly newId?: (prefix: string) => string;
}

const randomId = (prefix: string) =>
  `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** Lines of OCR text given to a model at most, nearest the cue first. */
const PROMPT_LINES = 40;

interface Heard {
  readonly utteranceId: string;
  readonly text: string;
  readonly language: string;
  readonly reading: Reading;
}

/**
 * What a local task reads from a session. The turn is the first one an interpretation completed
 * on a recorded view: the person's words as stored, that observation, and its stored frame digest.
 */
export interface TaskTurn {
  readonly turn: {
    readonly utteranceId: string;
    readonly words: string;
    readonly observationId: string;
    readonly frameSha256: string;
  } | null;
  /** Boopy's latest reply in the session, whichever turn it answered. */
  readonly dialogue: {
    readonly text: string;
    readonly utteranceId: string;
    readonly at: string;
  } | null;
  /** The session's selected subject. */
  readonly referent: Item | null;
}
