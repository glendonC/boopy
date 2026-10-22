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

/**
 * The service's core. Each request records journal events and applies them to the projection in
 * the same step; the session view is computed from the projection. One request at a time per
 * session.
 */
export class Boopy {
  readonly #turnProgress = new AsyncLocalStorage<(stage: TurnStage) => void>();
  readonly #deps: BoopyDeps;
  readonly #projection: Projection;
  readonly #notices = new Map<string, string>();
  readonly #busy = new Set<string>();
  #speechBusy = false;
  readonly #now: () => Date;
  readonly #newId: (prefix: string) => string;

  constructor(deps: BoopyDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? (() => new Date());
    this.#newId = deps.newId ?? randomId;
    this.#projection = Projection.from(deps.journal.all());
    // One process owns this journal. Never replay unfinished capture/perception on startup.
    for (const request of this.#projection.startRequests.values()) {
      if (request.status === 'pending')
        this.#record({
          type: 'session.start.finished',
          session: request.sessionId,
          actor: 'system',
          data: {
            requestId: request.requestId,
            outcome: 'interrupted',
            failureCode: 'start_interrupted',
          },
        });
    }
  }

  get interpreter(): { provider: string; model: string } {
    return { provider: this.#deps.interpreter.provider, model: this.#deps.interpreter.model };
  }

  get speechOutputAvailable(): boolean {
    return this.#deps.speechOutput != null;
  }

  get segmenter(): { provider: string; model: string } | null {
    const segmenter = this.#deps.segmenter;
    return segmenter == null ? null : { provider: segmenter.provider, model: segmenter.model };
  }

  /** The local recognizer session turns use, or null when speech is not set up on this Mac. */
  get speechRecognizer(): SpeechEngine | null {
    return this.#deps.speech;
  }

  /**
   * Read-only copies of what a local task takes from a session: its first completed visual turn,
   * Boopy's latest reply, and the selected subject. A part the session lacks is null. Reading
   * this never runs or changes a turn.
   */
  taskTurn(sessionId: string): TaskTurn {
    const session = this.#projection.session(sessionId);
    if (session === undefined) throw new BoopyError(404, 'no_session', 'No such session.');
    const first = session.interpretations[0];
    const observation = session.observations.find((entry) => entry.id === first?.observationId);
    const utterance = session.utterances.find((entry) => entry.id === first?.utteranceId);
    const failed =
      first !== undefined && session.interpretationFailure?.utteranceId === first.utteranceId;
    const dialogue = session.dialogue;
    const referent = session.items.find((item) => item.id === session.referentId);
    return {
      turn:
        observation === undefined || utterance === undefined || failed
          ? null
          : {
              utteranceId: utterance.id,
              words: utterance.text,
              observationId: observation.id,
              frameSha256: observation.frameSha256,
            },
      dialogue:
        dialogue === null
          ? null
          : { text: dialogue.text, utteranceId: dialogue.utteranceId, at: dialogue.at },
      referent: referent === undefined ? null : structuredClone(referent),
    };
  }

  /** Durable first-capture identity; failed work is never retried automatically. */
  async start(
    request: StartSessionRequest,
    progress?: (stage: TurnStage) => void,
  ): Promise<SessionView> {
    if (progress) return this.#turnProgress.run(progress, () => this.start(request));
    if (request.requestId === undefined) return this.#startNew(request);
    const normalized = StartSessionSchema.parse(request);
    const requestId = StartRequestId.parse(normalized.requestId);
    const requestSha256 = createHash('sha256')
      .update(
        JSON.stringify({ ...normalized, requestId: undefined }, (_key, value: unknown) =>
          value !== null && typeof value === 'object' && !Array.isArray(value)
            ? Object.fromEntries(
                Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
              )
            : value,
        ),
      )
      .digest('hex');
    const previous = this.#projection.startRequests.get(requestId);
    if (previous !== undefined) {
      if (previous.requestSha256 !== requestSha256)
        throw new BoopyError(
          409,
          'start_conflict',
          'This capture identity belongs to a different request.',
        );
      if (previous.status === 'succeeded') return this.view(previous.sessionId);
      throw new BoopyError(
        409,
        `start_${previous.status}`,
        'The earlier capture is not a completed start. Check its recorded status.',
      );
    }
    // Association is journaled synchronously before the first await in #startNew.
    return this.#startNew(normalized, { requestId, requestSha256 });
  }

  startStatus(requestId: string): StartRecoveryView {
    StartRequestId.parse(requestId);
    const request = this.#projection.startRequests.get(requestId);
    if (request === undefined)
      throw new BoopyError(404, 'start_unknown', 'No recorded capture has this identity.');
    return {
      requestId,
      sessionId: request.sessionId,
      status: request.status,
      failureCode: request.failureCode,
      view: request.status === 'succeeded' ? this.view(request.sessionId) : null,
    };
  }

  /** A new session: the frame and cues at the start of the pinch, then what was said. */
  async #startNew(
    request: StartSessionRequest,
    association?: { requestId: string; requestSha256: string },
  ): Promise<SessionView> {
    if (request.frame === undefined && request.attention?.evidence !== 'none')
      throw new BoopyError(400, 'no_frame', 'A frame is required for a visual turn.');
    const session = this.#newId('ses');
    this.#record({
      type: 'session.started',
      session,
      actor: 'person',
      data: {
        device: request.device ?? null,
        ...(association === undefined ? {} : { startRequest: association }),
      },
    });
    try {
      const view = await this.#exclusive(session, async () => {
        const observationId =
          request.frame === undefined
            ? null
            : await this.#observe(session, request.frame, request.cues);
        const heard = await this.#hear(
          session,
          request.speech,
          observationId,
          null,
          request.attention?.source,
        );
        if (heard.reading.kind === 'commit') {
          this.#notices.set(session, 'There is nothing to save yet. Look at something and talk.');
          if (association !== undefined) this.#respond(session, heard.utteranceId);
          return;
        }
        const scope = heard.reading.kind === 'rescope' ? 'scene' : 'auto';
        if (scope === 'scene')
          this.#correct(session, {
            op: 'rescope',
            scope: 'scene',
            via: 'voice',
            utteranceId: heard.utteranceId,
          });
        await this.#attend(session, observationId, heard, scope, request.attention, observationId);
        if (association !== undefined && this.#open(session).dialogue === null)
          this.#respond(session, heard.utteranceId);
      });
      if (association !== undefined)
        this.#record({
          type: 'session.start.finished',
          session,
          actor: 'system',
          data: { requestId: association.requestId, outcome: 'succeeded', failureCode: null },
        });
      return view;
    } catch (failure) {
      if (association !== undefined)
        this.#record({
          type: 'session.start.finished',
          session,
          actor: 'system',
          data: {
            requestId: association.requestId,
            outcome: 'failed',
            failureCode:
              failure instanceof BoopyError && /^[a-z][a-z0-9_]{0,63}$/.test(failure.code)
                ? failure.code
                : 'internal',
          },
        });
      throw failure;
    }
  }

  #currentChoice(sessionId: string, input: ChoiceSelection) {
    const session = this.#open(sessionId);
    const dialogue = session.dialogue;
    const card = dialogue?.choice;
    const option = card?.options.find((candidate) => candidate.id === input.optionId);
    const interpretation = session.interpretations.find(
      (candidate) => candidate.utteranceId === dialogue?.utteranceId,
    );
    if (
      dialogue?.utteranceId !== input.utteranceId ||
      dialogue.at !== input.responseAt ||
      card?.id !== input.cardId ||
      option === undefined ||
      interpretation === undefined ||
      !session.observations.some((observation) => observation.id === interpretation.observationId)
    )
      throw new BoopyError(409, 'stale_choice', 'That choice is no longer available. Ask again.');
    return { card, option, observationId: interpretation.observationId };
  }

  /** Selection changes only the current widget value, never evidence or interpretation. */
  async selectChoice(sessionId: string, input: ChoiceSelection): Promise<SessionView> {
    await this.#exclusive(sessionId, async () => {
      this.#currentChoice(sessionId, input);
      this.#record({
        type: 'interaction.choice-selected',
        session: sessionId,
        actor: 'person',
        data: input,
      });
    });
    return this.view(sessionId);
  }
}
