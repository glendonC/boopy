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

  /** Explicit submission sends the server-bound choice as informational input. */
  async submitChoice(
    sessionId: string,
    input: ChoiceSelection,
    progress?: (stage: TurnStage) => void,
  ): Promise<SessionView> {
    if (progress)
      return this.#turnProgress.run(progress, () => this.submitChoice(sessionId, input));
    await this.#exclusive(sessionId, async () => {
      const { card, option, observationId } = this.#currentChoice(sessionId, input);
      if (card.selectedOptionId !== option.id)
        throw new BoopyError(409, 'choice_not_selected', 'Select an option before sending it.');
      const heard = await this.#hear(
        sessionId,
        { text: `${card.prompt}\nSelected: ${option.value}` },
        observationId,
        null,
        'unknown',
        undefined,
        input,
      );
      const reason =
        'The person submitted a selected choice as informational input; no new capture or evidence verification.';
      this.#record({
        type: 'attention.decided',
        session: sessionId,
        actor: 'system',
        data: {
          utteranceId: heard.utteranceId,
          source:
            this.#open(sessionId).observations.find(
              (observation) => observation.id === observationId,
            )?.source ?? 'unknown',
          action: 'reuse',
          reason,
          observationId,
          work: { ocr: true, segmentation: false },
        },
      });
      await this.#interpret(sessionId, observationId, heard, 'auto', {
        ocr: true,
        segmentation: false,
        reason,
      });
      this.#respond(sessionId, heard.utteranceId);
    });
    return this.view(sessionId);
  }

  /** Something said during a session: a correction, a new question, a rescope or a commit. */
  async utter(
    sessionId: string,
    request: UtteranceRequest,
    progress?: (stage: TurnStage) => void,
  ): Promise<SessionView> {
    if (progress) return this.#turnProgress.run(progress, () => this.utter(sessionId, request));
    this.#open(sessionId);
    return this.#exclusive(sessionId, async () => {
      const session = this.#open(sessionId);
      const selected =
        request.selection === undefined
          ? undefined
          : session.dialogue?.actions?.find(
              (action) =>
                action.id === request.selection?.actionId &&
                session.dialogue?.utteranceId === request.selection.utteranceId &&
                session.dialogue.at === request.selection.responseAt,
            );
      if (
        request.selection !== undefined &&
        (selected === undefined ||
          request.frame !== undefined ||
          request.attention !== undefined ||
          !('text' in request.speech) ||
          request.speech.text !== selected.question ||
          (request.cues?.targetItemId ?? null) !== selected.targetItemId ||
          request.cues?.gaze !== undefined ||
          request.cues?.pointer !== undefined ||
          selected.observationId === null ||
          !session.observations.some((observation) => observation.id === selected.observationId))
      )
        throw new BoopyError(
          409,
          'stale_suggestion',
          'That suggestion is no longer available. Ask your question again.',
        );
      const cues = request.cues ?? {};
      const target = cues.targetItemId ?? null;
      const targetItem = target === null ? null : session.items.find((item) => item.id === target);
      if (target !== null && targetItem == null)
        throw new BoopyError(404, 'no_item', 'That card is not in this session.');
      if (targetItem?.status === 'ignored' || targetItem?.status === 'rejected')
        throw new BoopyError(
          409,
          'inactive_item',
          'That card is excluded. Include it before referring to it.',
        );
      const targetObservationId =
        targetItem == null
          ? null
          : (targetItem.grounding.observationId ??
            session.interpretations.find(
              (interpretation) => interpretation.id === targetItem.interpretationId,
            )?.observationId ??
            null);
      const suppliedObservationId =
        request.frame === undefined ? null : await this.#observe(sessionId, request.frame, cues);
      const observationId =
        selected?.observationId ??
        (suppliedObservationId === null && targetItem != null
          ? targetObservationId
          : request.attention === undefined
            ? (suppliedObservationId ?? session.observations.at(-1)?.id ?? null)
            : this.#attentionObservation(session, request.attention, suppliedObservationId));
      const heard = await this.#hear(
        sessionId,
        request.speech,
        observationId,
        target,
        selected === undefined
          ? request.attention?.source
          : session.observations.find((observation) => observation.id === selected.observationId)
              ?.source,
        request.selection,
      );
      const reading = heard.reading;
      if (selected !== undefined && observationId !== null) {
        const reason =
          'The person selected a proposed follow-up about this recorded view; no new capture or confirmation.';
        this.#record({
          type: 'attention.decided',
          session: sessionId,
          actor: 'system',
          data: {
            utteranceId: heard.utteranceId,
            source: session.observations.find((o) => o.id === observationId)?.source ?? 'unknown',
            action: 'reuse',
            reason,
            observationId,
            work: { ocr: true, segmentation: false },
          },
        });
        await this.#interpret(
          sessionId,
          observationId,
          heard,
          'auto',
          { ocr: true, segmentation: false, reason },
          targetItem ?? undefined,
        );
        this.#respond(sessionId, heard.utteranceId);
        return;
      }
      if (reading.kind === 'refocus' && targetItem != null) {
        this.#record({
          type: 'interaction.focused',
          session: sessionId,
          actor: 'person',
          data: { utteranceId: heard.utteranceId, itemId: targetItem.id },
        });
        this.#notices.set(sessionId, `Now talking about "${targetItem.label}".`);
        this.#respond(sessionId, heard.utteranceId);
        return;
      }
      if (reading.kind === 'ask' && targetItem != null) {
        await this.#askTarget(sessionId, targetItem, targetObservationId, heard, request.attention);
        return;
      }
      switch (reading.kind) {
        case 'commit':
          this.#commit(sessionId);
          if (request.attention !== undefined) this.#respond(sessionId, heard.utteranceId);
          return;
        case 'refocus':
        case 'ask':
          if (observationId === null && request.attention === undefined)
            throw new BoopyError(409, 'no_frame', 'No frame to look at.');
          await this.#attend(
            sessionId,
            observationId,
            heard,
            'auto',
            request.attention,
            suppliedObservationId,
          );
          return;
        case 'rescope':
          if (observationId === null && request.attention === undefined)
            throw new BoopyError(409, 'no_frame', 'No frame to look at.');
          this.#correct(sessionId, {
            op: 'rescope',
            scope: 'scene',
            via: 'voice',
            utteranceId: heard.utteranceId,
          });
          await this.#attend(
            sessionId,
            observationId,
            heard,
            'scene',
            request.attention,
            suppliedObservationId,
          );
          return;
        case 'add':
          this.#add(sessionId, reading.text, cues, observationId, heard.utteranceId);
          if (request.attention !== undefined) this.#respond(sessionId, heard.utteranceId);
          return;
        default:
          this.#voiceCorrection(sessionId, reading, heard, target);
          if (request.attention !== undefined) this.#respond(sessionId, heard.utteranceId);
      }
    });
  }

  /** A pinch on a card. */
  act(sessionId: string, request: ActionRequest): SessionView {
    const session = this.#open(sessionId);
    if (this.#busy.has(sessionId))
      throw new BoopyError(409, 'busy', 'Still working on the last request.');
    const item = session.items.find((candidate) => candidate.id === request.itemId);
    if (item === undefined) throw new BoopyError(404, 'no_item', 'That card is gone.');
    this.#correct(sessionId, {
      op: request.action,
      itemId: item.id,
      via: 'pinch',
      utteranceId: null,
    });
    this.#notices.set(sessionId, actionNotice(request.action, item.label));
    return this.view(sessionId);
  }

  commit(sessionId: string): SessionView {
    this.#open(sessionId);
    if (this.#busy.has(sessionId))
      throw new BoopyError(409, 'busy', 'Still working on the last request.');
    this.#commit(sessionId);
    return this.view(sessionId);
  }

  view(sessionId: string): SessionView {
    const session = this.#projection.session(sessionId);
    if (session === undefined) throw new BoopyError(404, 'no_session', 'No such session.');
    const last = session.interpretations.at(-1);
    const pkg =
      session.committed === null
        ? undefined
        : this.#projection.packages.get(session.committed.packageId);
    return {
      id: session.id,
      speechOutputAvailable: this.#deps.speechOutput != null,
      state: session.state,
      scope: session.scope,
      referentId: session.referentId,
      intentId: session.intentId,
      items: session.items,
      relations: session.relations,
      observations: session.observations.map((o) => ({ id: o.id, capturedAt: o.capturedAt })),
      utterances: session.utterances.map((u) => ({
        id: u.id,
        text: u.text,
        language: u.language,
        kind: utteranceKind(u.reading),
      })),
      model:
        last === undefined
          ? null
          : { provider: last.provider, id: last.model, latencyMs: last.latencyMs },
      notice: this.#notices.get(sessionId) ?? session.dialogue?.text ?? null,
      interpretationFailure:
        session.interpretationFailure?.utteranceId === session.utterances.at(-1)?.id
          ? session.interpretationFailure
          : null,
      ...(session.attention !== null && { attention: session.attention }),
      ...(session.dialogue !== null && { dialogue: session.dialogue }),
      committed:
        session.committed === null || pkg === undefined
          ? null
          : {
              packageId: session.committed.packageId,
              at: session.committed.at,
              summary: summarize(pkg),
            },
    };
  }

  /** Generate only the actual current journaled Boopy reply; capture/commit never waits for speech. */
  async speak(
    sessionId: string,
    request: SpeechOutputRequest,
    signal?: AbortSignal,
  ): Promise<SpeechOutputResponse> {
    const output = this.#deps.speechOutput;
    if (output == null)
      throw new BoopyError(503, 'speech_unavailable', 'Boopy voice is not enabled on this Mac.');
    const response = this.#speechResponse(sessionId, request);
    if (this.#speechBusy)
      throw new BoopyError(
        409,
        'speech_busy',
        'Boopy voice is busy. Captions are still available.',
      );
    if (signal?.aborted) throw new BoopyError(409, 'speech_cancelled', 'Boopy voice was stopped.');
    this.#speechBusy = true;
    const attemptId = this.#newId('spk');
    this.#record({
      type: 'speech.requested',
      session: sessionId,
      actor: 'person',
      data: { attemptId, ...request },
    });
    try {
      // Select between the two configured local voices from the actual reply, not the
      // language of the person's question. This is a script heuristic, not language ID.
      const result = await output.synthesize(
        response.text,
        /\p{Script=Hangul}/u.test(response.text) ? 'ko' : 'en',
        signal,
      );
      if (signal?.aborted)
        throw new BoopyError(409, 'speech_cancelled', 'Boopy voice was stopped.');
      this.#speechResponse(sessionId, request);
      this.#record({
        type: 'speech.finished',
        session: sessionId,
        actor: 'system',
        data: {
          attemptId,
          ...request,
          outcome: 'generated',
          voice: result.voice,
          language: result.language,
          latencyMs: result.latencyMs,
          bytes: result.wav.length,
        },
      });
      return {
        sessionId,
        ...request,
        speaker: 'boopy',
        mimeType: 'audio/wav',
        wav: result.wav.toString('base64'),
        voice: result.voice,
        language: result.language,
        latencyMs: result.latencyMs,
      };
    } catch (error) {
      const cancelled = signal?.aborted === true;
      const stale = error instanceof BoopyError && error.code === 'stale_response';
      this.#record({
        type: 'speech.finished',
        session: sessionId,
        actor: 'system',
        data: {
          attemptId,
          ...request,
          outcome: cancelled ? 'cancelled' : stale ? 'stale' : 'failed',
        },
      });
      if (cancelled) throw new BoopyError(409, 'speech_cancelled', 'Boopy voice was stopped.');
      if (stale) throw error;
      throw new BoopyError(
        502,
        'speech_failed',
        'Boopy voice is unavailable. The response remains in captions.',
      );
    } finally {
      this.#speechBusy = false;
    }
  }

  #speechResponse(sessionId: string, request: SpeechOutputRequest) {
    const session = this.#projection.session(sessionId);
    if (session === undefined) throw new BoopyError(404, 'no_session', 'No such session.');
    const response = session.dialogue;
    if (
      this.#busy.has(sessionId) ||
      response == null ||
      response.utteranceId !== request.utteranceId ||
      response.at !== request.responseAt
    )
      throw new BoopyError(409, 'stale_response', 'That Boopy response is no longer current.');
    return response;
  }
}
