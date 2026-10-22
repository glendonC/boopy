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

  /** Committed packages, newest first. */
  packages(): ContextPackage[] {
    return [...this.#projection.packages.values()].sort((a, b) =>
      b.committedAt.localeCompare(a.committedAt),
    );
  }

  package(id: string): ContextPackage | undefined {
    return this.#projection.packages.get(id);
  }

  /** An explicit person action links immutable records; matching labels never imply identity. */
  supersede(input: SupersedeRequest): Supersession {
    const request = SupersedeRequest.parse(input);
    const predecessor = this.#committedEvidence(request.predecessor);
    const successor = this.#committedEvidence(request.successor);
    if (predecessor.sourceId === successor.sourceId)
      throw new BoopyError(409, 'invalid_supersession', 'An item cannot replace itself.');
    const prior = this.#projection.supersessions.find(
      (link) => evidenceSourceId(link.predecessor) === predecessor.sourceId,
    );
    if (prior !== undefined) {
      if (evidenceSourceId(prior.successor) === successor.sourceId) return prior;
      throw new BoopyError(409, 'correction_conflict', 'That source already has a successor.');
    }
    if (
      this.#projection.supersessions.some(
        (link) => evidenceSourceId(link.predecessor) === successor.sourceId,
      )
    )
      throw new BoopyError(409, 'stale_successor', 'Choose a current successor.');
    const successorPackage = this.package(successor.packageId);
    if (successorPackage === undefined) throw new BoopyError(404, 'no_package', 'No such package.');
    const event = this.#record({
      type: 'evidence.superseded',
      session: successorPackage.sessionId,
      actor: 'person',
      data: request,
    });
    return { ...request, eventId: event.id, at: event.at };
  }

  get supersessions(): readonly Supersession[] {
    return this.#projection.supersessions;
  }

  #committedEvidence(ref: EvidenceRef) {
    const pkg = this.package(ref.packageId);
    if (pkg === undefined) throw new BoopyError(404, 'no_package', 'No such committed package.');
    if (pkg.version !== 2)
      throw new BoopyError(409, 'legacy_evidence', 'This package lacks versioned evidence.');
    const record = evidenceRecords(pkg).find((item) => item.itemId === ref.itemId);
    if (record === undefined)
      throw new BoopyError(404, 'no_evidence', 'No such exported evidence.');
    return record;
  }

  /** Records that an agent read a package. */
  disclose(pkg: ContextPackage, agent: string, via: 'mcp' | 'rest', tool: string): void {
    this.#record({
      type: 'context.disclosed',
      session: pkg.sessionId,
      actor: `agent:${agent}`,
      data: { packageId: pkg.id, agent, via, tool },
    });
  }

  get disclosures() {
    return this.#projection.disclosures;
  }

  #record(event: BoopyEvent): Recorded {
    const recorded = this.#deps.journal.append(
      event,
      this.#newId('evt'),
      this.#now().toISOString(),
    );
    this.#projection.apply(recorded);
    return recorded;
  }

  #open(sessionId: string): SessionState {
    const session = this.#projection.session(sessionId);
    if (session === undefined) throw new BoopyError(404, 'no_session', 'No such session.');
    if (session.state === 'committed') {
      throw new BoopyError(409, 'committed', 'This session is saved. Start a new one.');
    }
    return session;
  }

  async #exclusive(sessionId: string, work: () => Promise<void>): Promise<SessionView> {
    if (this.#busy.has(sessionId))
      throw new BoopyError(409, 'busy', 'Still working on the last request.');
    this.#busy.add(sessionId);
    try {
      await work();
    } finally {
      this.#busy.delete(sessionId);
    }
    return this.view(sessionId);
  }

  async #observe(session: string, frame: Frame, cues: Cues): Promise<string> {
    const jpeg = Buffer.from(frame.jpeg, 'base64');
    if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) {
      throw new BoopyError(400, 'invalid_frame', 'The frame is not a JPEG.');
    }
    const observationId = this.#newId('obs');
    this.#record({
      type: 'observation.recorded',
      session,
      actor: 'person',
      data: {
        observationId,
        frameSha256: this.#deps.media.put(jpeg, 'jpg'),
        width: frame.width,
        height: frame.height,
        capturedAt: frame.capturedAt,
        source: frame.source ?? 'unknown',
        timestampTrusted: frame.timestampTrusted ?? false,
        camera: frame.camera ?? null,
        depth: frame.depth ?? null,
        cues,
      },
    });
    return observationId;
  }

  async #hear(
    session: string,
    speech: Speech,
    observationId: string | null,
    targetItemId: string | null,
    evidenceSource: AttentionInput['source'] = 'unknown',
    selection?: ContextualActionSelection,
    choiceSelection?: ChoiceSelection,
  ): Promise<Heard> {
    let text: string;
    let language: string;
    let audioSha256: string | null = null;
    let transcriber: string | null = null;
    if ('wav' in speech) {
      const engine = this.#deps.speech;
      if (engine === null) {
        throw new BoopyError(503, 'no_speech', 'Speech is not set up on this Mac.');
      }
      const wav = Buffer.from(speech.wav, 'base64');
      audioSha256 = this.#deps.media.put(wav, 'wav');
      this.#processing(session, 'transcribing', null, observationId);
      const heard = await engine.transcribe(wav).catch(() => {
        throw new BoopyError(
          502,
          'speech_failed',
          'Could not transcribe this recording. Please try again.',
        );
      });
      text = heard.text;
      language = heard.language;
      transcriber = engine.name;
    } else {
      text = speech.text;
      language = speech.language ?? (/[가-힣]/.test(speech.text) ? 'ko' : 'en');
    }
    if (text.trim() === '')
      throw new BoopyError(422, 'no_words', 'I did not hear clear words. Please try again.');
    const utteranceId = this.#newId('utt');
    const reading: Reading =
      selection === undefined && choiceSelection === undefined
        ? readUtterance(text, targetItemId !== null)
        : { kind: 'ask' };
    this.#record({
      type: 'utterance.heard',
      session,
      actor: 'person',
      data: {
        utteranceId,
        observationId,
        text,
        language,
        source:
          choiceSelection !== undefined
            ? 'choice'
            : selection !== undefined
              ? 'suggestion'
              : 'wav' in speech
                ? 'speech'
                : 'typed',
        ...(choiceSelection === undefined ? {} : { choiceSelection }),
        ...(selection === undefined ? {} : { selection }),
        evidenceSource,
        audioSha256,
        transcriber,
        targetItemId,
        reading,
      },
    });
    return { utteranceId, text, language, reading };
  }

  #attentionObservation(
    session: SessionState,
    input: AttentionInput,
    suppliedId: string | null,
  ): string | null {
    if (input.observationId !== undefined)
      return (
        session.observations.find((observation) => observation.id === input.observationId)?.id ??
        null
      );
    if (suppliedId !== null) return suppliedId;
    return (
      [...session.observations].reverse().find((observation) => observation.source === input.source)
        ?.id ?? null
    );
  }

  #respond(session: string, utteranceId: string): void {
    const text = this.#notices.get(session);
    if (text === undefined) return;
    const latest = this.#projection.session(session)?.interpretations.at(-1);
    const actions = latest?.utteranceId === utteranceId ? [...(latest.actions ?? [])] : [];
    this.#record({
      type: 'interaction.responded',
      session,
      actor: 'system',
      data: {
        speaker: 'boopy',
        text,
        utteranceId,
        ...(actions.length ? { actions } : {}),
        ...(latest?.utteranceId === utteranceId && latest.choice ? { choice: latest.choice } : {}),
      },
    });
  }

  async #attend(
    sessionId: string,
    observationId: string | null,
    heard: Heard,
    legacyScope: 'auto' | 'scene',
    input: AttentionInput | undefined,
    suppliedId: string | null,
  ): Promise<void> {
    if (input === undefined) {
      if (observationId === null) throw new BoopyError(409, 'no_frame', 'No frame to look at.');
      return this.#interpret(sessionId, observationId, heard, legacyScope);
    }
    const session = this.#open(sessionId);
    const selectedId = this.#attentionObservation(session, input, suppliedId);
    const observation = session.observations.find((candidate) => candidate.id === selectedId);
    const decision: AttentionDecision =
      input.observationId !== undefined && observation === undefined
        ? {
            action: 'clarify',
            reason:
              'That selected view is not in this session. Select a recorded view or capture another.',
            utterance: heard.text,
            observationId: null,
            work: { ocr: false, segmentation: false },
          }
        : decideAttention({
            ...input,
            utterance: heard.text,
            nowMs: this.#now().getTime(),
            ...(observation === undefined
              ? {}
              : {
                  observation: {
                    id: observation.id,
                    source: observation.source,
                    capturedAtMs: Date.parse(observation.capturedAt),
                    timestampTrusted: observation.timestampTrusted,
                    suppliedForTurn: observation.id === suppliedId,
                  },
                }),
          });
    this.#record({
      type: 'attention.decided',
      session: sessionId,
      actor: 'system',
      data: {
        utteranceId: heard.utteranceId,
        source: input.source,
        action: decision.action,
        reason: decision.reason,
        observationId: decision.observationId,
        work: decision.work,
      },
    });
    if (decision.action === 'reuse' && decision.observationId !== null) {
      await this.#interpret(
        sessionId,
        decision.observationId,
        heard,
        input.scope === 'scene' || legacyScope === 'scene' ? 'scene' : 'auto',
        { ...decision.work, reason: decision.reason },
      );
    } else {
      if (decision.action === 'no-visual-work') {
        this.#correct(sessionId, {
          op: 'add',
          via: 'voice',
          utteranceId: heard.utteranceId,
          item: {
            id: this.#newId('itm'),
            kind: 'utterance',
            label: heard.text.split(/\s+/).slice(0, 5).join(' '),
            statement: heard.text,
            grounding: { kind: 'scene' },
            confidence: null,
            origin: 'person',
            status: 'confirmed',
            emphasis: false,
          },
        });
      }
      const message =
        decision.action === 'no-visual-work'
          ? 'I kept your words without inspecting a view.'
          : decision.action === 'fresh-view'
            ? `Please capture another view. ${decision.reason}`
            : decision.reason;
      this.#notices.set(sessionId, message);
    }
    this.#respond(sessionId, heard.utteranceId);
  }

  /** A question at an existing annotation refers to its recorded evidence, not new pixels. */
  async #askTarget(
    sessionId: string,
    target: Item,
    observationId: string | null,
    heard: Heard,
    input: AttentionInput | undefined,
  ): Promise<void> {
    const session = this.#open(sessionId);
    const observation = session.observations.find((entry) => entry.id === observationId);
    const useVisual = input?.evidence !== 'none' && observation !== undefined;
    const reason = useVisual
      ? 'Inspect the explicitly selected recorded item. This does not establish its current physical state.'
      : input?.evidence === 'none'
        ? 'Keep the question without visual inspection, as requested.'
        : 'The selected item has no recorded view to inspect.';
    const work = {
      ocr: useVisual && (input?.ocrRequested ?? true),
      segmentation: useVisual && (input?.segmentationRequested ?? false),
    };
    this.#record({
      type: 'attention.decided',
      session: sessionId,
      actor: 'system',
      data: {
        utteranceId: heard.utteranceId,
        source: observation?.source ?? 'unknown',
        action: useVisual ? 'reuse' : input?.evidence === 'none' ? 'no-visual-work' : 'clarify',
        reason,
        observationId: useVisual ? observation.id : null,
        work,
      },
    });
    if (useVisual) {
      await this.#interpret(sessionId, observation.id, heard, 'auto', { ...work, reason }, target);
    } else {
      this.#correct(sessionId, {
        op: 'add',
        via: 'voice',
        utteranceId: heard.utteranceId,
        item: {
          id: this.#newId('itm'),
          kind: 'question',
          label: heard.text,
          statement: heard.text,
          grounding: { kind: 'scene' },
          confidence: null,
          origin: 'person',
          status: 'confirmed',
          emphasis: false,
        },
      });
      this.#notices.set(sessionId, `Kept your question about "${target.label}". ${reason}`);
    }
    this.#respond(sessionId, heard.utteranceId);
  }

  async #interpret(
    sessionId: string,
    observationId: string,
    heard: Heard,
    scope: 'auto' | 'scene',
    work?: { ocr: boolean; segmentation: boolean; reason: string },
    selectedTarget?: Item,
  ): Promise<void> {
    const session = this.#projection.session(sessionId);
    const observation = session?.observations.find((o) => o.id === observationId);
    if (session === undefined || observation === undefined) {
      throw new BoopyError(404, 'no_observation', 'No such observation.');
    }
    const jpeg = this.#deps.media.get(observation.frameSha256, 'jpg');
    // T marks the selected record, not fabricated hand/head input or a box in a new frame.
    const targetBox =
      selectedTarget?.grounding.observationId === observationId
        ? (selectedTarget.grounding.box ?? null)
        : null;
    const targetPoint =
      targetBox === null
        ? null
        : { x: (targetBox.x0 + targetBox.x1) / 2, y: (targetBox.y0 + targetBox.y1) / 2 };
    const gaze = selectedTarget === undefined ? (observation.cues.gaze?.point ?? null) : null;
    const pointer = selectedTarget === undefined ? (observation.cues.pointer?.point ?? null) : null;
    const [lines, evidence] = await Promise.all([
      work?.ocr === false
        ? Promise.resolve([] as TextLine[])
        : this.#readText(sessionId, observationId, jpeg, heard.utteranceId),
      prepareEvidence(jpeg, { gaze, pointer }, targetPoint),
    ]);
    const focus: Point = targetPoint ?? pointer ?? gaze ?? { x: 0.5, y: 0.5 };
    const interpreter = this.#deps.interpreter;
    const interpretationId = this.#newId('int');
    const started = performance.now();
    try {
      this.#processing(sessionId, 'interpreting', heard.utteranceId, observationId);
      const result = await interpreter.interpret({
        inputSource: session.utterances.find((utterance) => utterance.id === heard.utteranceId)
          ?.source,
        conversation: session.conversation
          .filter((turn) => turn.utteranceId !== heard.utteranceId)
          .slice(-6),
        contextualItems: session.items
          .filter((item) => item.status !== 'ignored' && item.status !== 'rejected')
          .slice(-8)
          .map(({ id, kind, label, statement, status, origin, confidence, note }) => ({
            id,
            kind,
            label,
            statement,
            status,
            origin,
            confidence,
            ...(note === undefined ? {} : { note }),
          })),
        said: heard.text === '' ? 'What is this?' : heard.text,
        language: heard.language,
        ...(selectedTarget === undefined
          ? {}
          : {
              selectedReference: {
                itemId: selectedTarget.id,
                observationId,
                label: selectedTarget.label,
                statement: selectedTarget.statement,
                verification: verificationOf(selectedTarget),
                disposition: selectedTarget.status,
                confidence: selectedTarget.confidence,
                box: targetBox,
                text: selectedTarget.text ?? [],
                ...(selectedTarget.note === undefined ? {} : { note: selectedTarget.note }),
              },
            }),
        sourceContext: {
          source: observation.source,
          capturedAt: observation.capturedAt,
          timestampTrusted: observation.timestampTrusted,
          selectionReason:
            work?.reason ?? 'Legacy selected view; current scene/time not established.',
        },
        scope,
        gaze,
        pointer,
        image: evidence.marked,
        crop: evidence.crop,
        text: nearest(lines, focus.x, focus.y, PROMPT_LINES),
        decisions: session.items.filter(touched).map((item) => ({
          label: item.label,
          status: item.status,
          ...(item.note !== undefined && { note: item.note }),
        })),
      });
      const latencyMs = Math.round(performance.now() - started);
      const normalized = normalize(result.output, {
        interpretationId,
        observationId,
        scope,
        text: lines,
      });
      const answer = result.output.response?.trim() ?? '';
      if (answer !== '') {
        const answerId = `${interpretationId}.__reply`;
        normalized.items.push({
          id: answerId,
          kind: 'note',
          label: 'Suggested answer',
          statement: answer,
          grounding: { kind: 'scene', observationId },
          confidence: null,
          origin: 'model',
          status: 'proposed',
          emphasis: false,
          interpretationId,
        });
        const answeredReferent = selectedTarget?.id ?? normalized.referentId;
        if (answeredReferent != null)
          normalized.relations.push({
            id: `${interpretationId}.__reply-about`,
            from: answerId,
            to: answeredReferent,
            kind: 'about',
          });
      }
      const actionTarget = selectedTarget?.id ?? normalized.referentId;
      const actions: ContextualAction[] =
        answer === ''
          ? []
          : [...new Set((result.output.followUps ?? []).map((s) => s.question.trim()))]
              .filter(
                (question) =>
                  question.length > 0 &&
                  question.length <= 120 &&
                  readUtterance(question, false).kind === 'ask',
              )
              .slice(0, 2)
              .map((question, index) => ({
                id: `${interpretationId}.followup-${index + 1}`,
                question,
                targetItemId: actionTarget,
                observationId,
              }));
      const proposedChoice = choiceForResponse(result.output);
      const choice: ChoiceCard | undefined =
        proposedChoice !== undefined
          ? {
              id: `${interpretationId}.choice`,
              kind: 'choice',
              prompt: proposedChoice.prompt,
              options: proposedChoice.options.map((option, index) => ({
                id: `${interpretationId}.choice-option-${index + 1}`,
                label: option.label,
                value: option.value,
              })),
              selectedOptionId: null,
            }
          : undefined;
      this.#record({
        type: 'interpretation.proposed',
        session: sessionId,
        actor: `model:${interpreter.provider}:${interpreter.model}`,
        data: {
          interpretationId,
          observationId,
          utteranceId: heard.utteranceId,
          provider: interpreter.provider,
          model: interpreter.model,
          latencyMs,
          ...normalized,
          ...(selectedTarget === undefined ? {} : { referentId: selectedTarget.id }),
          raw: result.raw,
          actions,
          ...(choice === undefined ? {} : { choice }),
        },
      });
      this.#notices.set(
        sessionId,
        answer !== ''
          ? answer
          : selectedTarget !== undefined
            ? "I couldn't answer that from the recorded view. Could you rephrase your question?"
            : "I couldn't tell what you meant from this view. Point at one thing and ask again.",
      );
      if (work?.segmentation !== false)
        await this.#refineGrounding(
          sessionId,
          observationId,
          interpretationId,
          heard.utteranceId,
          jpeg,
          pointer ?? gaze,
        );
    } catch (failure) {
      // Provider exceptions may echo private inputs or credentials; never persist or speak them.
      const code =
        interpreter.provider === 'ollama' && failure instanceof InterpreterUnavailableError
          ? 'interpreter_unavailable'
          : 'interpreter_failed';
      const message =
        code === 'interpreter_unavailable'
          ? 'I can’t reach the model on your Mac. Try again once it’s running.'
          : 'Could not interpret that. Please try again.';
      this.#record({
        type: 'interpretation.failed',
        session: sessionId,
        actor: 'system',
        data: {
          observationId,
          utteranceId: heard.utteranceId,
          provider: interpreter.provider,
          model: interpreter.model,
          message,
          code,
        },
      });
      this.#notices.set(sessionId, message);
    }
  }

  async #refineGrounding(
    sessionId: string,
    observationId: string,
    interpretationId: string,
    utteranceId: string,
    jpeg: Buffer,
    focus: Point | null,
  ): Promise<void> {
    const segmenter = this.#deps.segmenter;
    if (segmenter === undefined || segmenter === null) return;
    const session = this.#projection.session(sessionId);
    const observation = session?.observations.find((candidate) => candidate.id === observationId);
    if (session === undefined || observation === undefined) return;
    const eligible = session.items.filter(
      (item) =>
        item.origin === 'model' &&
        item.status === 'proposed' &&
        item.interpretationId === interpretationId &&
        item.grounding.observationId === observationId &&
        item.grounding.box !== undefined &&
        item.label.trim() !== '' &&
        (item.id === session.referentId || item.kind === 'object' || item.kind === 'text'),
    );
    const ordered = [
      ...eligible.filter((item) => item.id === session.referentId),
      ...eligible.filter((item) => item.id !== session.referentId),
    ].slice(0, MAX_SEGMENT_ITEMS);
    if (ordered.length === 0) return;
    this.#processing(sessionId, 'refining-geometry', utteranceId, observation.id);
    const started = performance.now();
    const answers = await segmentItems(
      segmenter,
      ordered.map((item) => ({
        image: jpeg,
        width: observation.width,
        height: observation.height,
        concept: item.label.trim().slice(0, 120),
        box: item.grounding.box as Box,
        // The capture point refers to the primary object; it must not suppress other scene objects.
        focus: item.id === session.referentId ? focus : null,
      })),
    );
    let unavailable = 0;
    ordered.forEach((item, index) => {
      const result = answers[index] ?? {
        outcome: 'failed' as const,
        latencyMs: Math.round(performance.now() - started),
        confidence: null,
      };
      if (
        !this.#recordRefinement(
          sessionId,
          item,
          observation,
          interpretationId,
          utteranceId,
          result,
          segmenter,
        )
      )
        unavailable++;
    });
    if (unavailable > 0)
      this.#notices.set(
        sessionId,
        `${this.#notices.get(sessionId) ?? ''} ${unavailable} outline${unavailable === 1 ? '' : 's'} unavailable, shown as ${unavailable === 1 ? 'an approximate box' : 'approximate boxes'}.`.trim(),
      );
    if (eligible.length > ordered.length)
      this.#notices.set(
        sessionId,
        `${this.#notices.get(sessionId) ?? ''} ${eligible.length - ordered.length} more object${eligible.length - ordered.length === 1 ? '' : 's'} kept as approximate boxes (capture limit).`.trim(),
      );
  }

  #recordRefinement(
    sessionId: string,
    item: Item,
    observation: Observation,
    interpretationId: string,
    utteranceId: string,
    result: SegmentResult,
    segmenter: Segmenter,
  ): boolean {
    const requestedConcept = item.label.trim().slice(0, 120);
    const concept = result.concept ?? requestedConcept;
    let spatial: SpatialEvidence = {
      provider: segmenter.provider,
      model: segmenter.model,
      concept,
      latencyMs: result.latencyMs,
      confidence: result.confidence,
      verification: 'proposed' as const,
      outcome: result.outcome,
      frameSha256: observation.frameSha256,
      utteranceId,
    };
    const candidate = Grounding.safeParse({
      ...item.grounding,
      ...(result.contour !== undefined && { contour: result.contour }),
      spatial,
    });
    let contour = candidate.success ? candidate.data.contour : undefined;
    const failed = () => {
      contour = undefined;
      spatial = {
        provider: segmenter.provider,
        model: segmenter.model,
        concept: requestedConcept,
        latencyMs:
          Number.isFinite(result.latencyMs) && result.latencyMs >= 0 ? result.latencyMs : 0,
        confidence: null,
        verification: 'proposed',
        outcome: 'failed',
        frameSha256: observation.frameSha256,
        utteranceId,
      };
    };
    if (
      !candidate.success ||
      (result.outcome === 'contour') !== (contour !== undefined) ||
      (result.outcome !== 'contour' && result.mask !== undefined)
    )
      failed();
    else if (result.mask !== undefined) {
      try {
        if (!Buffer.isBuffer(result.mask)) throw new Error('Invalid mask artifact.');
        spatial.maskSha256 = this.#deps.media.put(result.mask, 'mask');
      } catch {
        failed();
      }
    }
    this.#record({
      type: 'grounding.refined',
      session: sessionId,
      actor: `model:${segmenter.provider}:${segmenter.model}`,
      data: {
        itemId: item.id,
        observationId: observation.id,
        interpretationId,
        ...(contour !== undefined && { contour }),
        spatial,
      },
    });
    return spatial.outcome === 'contour';
  }

  async #readText(
    session: string,
    observationId: string,
    jpeg: Buffer,
    utteranceId: string,
  ): Promise<TextLine[]> {
    const reader = this.#deps.text;
    if (reader === null) return [];
    this.#processing(session, 'reading-text', utteranceId, observationId);
    const lines = await reader.read(jpeg).catch(() => [] as TextLine[]);
    if (lines.length > 0) {
      this.#record({
        type: 'text.read',
        session,
        actor: 'system',
        data: { observationId, engine: reader.name, region: null, lines },
      });
    }
    return lines;
  }

  #processing(
    session: string,
    stage: TurnStage,
    utteranceId: string | null,
    observationId: string | null,
  ): void {
    const observer = this.#turnProgress.getStore();
    if (!observer) return;
    this.#record({
      type: 'turn.processing',
      session,
      actor: 'system',
      data: { stage, utteranceId, observationId },
    });
    // A disconnected status observer must never fail journaled conversation work.
    try {
      observer(stage);
    } catch {
      /* Transport observers are optional. */
    }
  }

  #correct(session: string, correction: Correction): void {
    this.#record({ type: 'item.corrected', session, actor: 'person', data: correction });
  }

  /** The card the person meant: the one under the ray, else the one whose name they said. */
  #target(session: SessionState, targetItemId: string | null, said: string): Item | null {
    if (targetItemId !== null) {
      return session.items.find((item) => item.id === targetItemId) ?? null;
    }
    const words = ` ${normalizeWords(said)} `;
    const named = session.items.filter((item) =>
      [item.label, item.gloss].some(
        (name) =>
          name !== undefined && name.trim() !== '' && words.includes(` ${normalizeWords(name)} `),
      ),
    );
    return named.length === 1 ? (named[0] ?? null) : null;
  }

  #voiceCorrection(sessionId: string, reading: Reading, heard: Heard, targetItemId: string | null) {
    const session = this.#open(sessionId);
    const item = this.#target(session, targetItemId, heard.text);
    if (item === null) {
      this.#notices.set(sessionId, 'Which one? Point at a card and say it again.');
      return;
    }
    const via = 'voice';
    const utteranceId = heard.utteranceId;
    switch (reading.kind) {
      case 'item':
        this.#correct(sessionId, {
          op: reading.action,
          itemId: item.id,
          via,
          utteranceId,
          ...(reading.reason !== undefined && { reason: reading.reason }),
        });
        this.#notices.set(sessionId, actionNotice(reading.action, item.label));
        return;
      case 'relabel':
        this.#correct(sessionId, {
          op: 'relabel',
          itemId: item.id,
          label: reading.label,
          via,
          utteranceId,
        });
        this.#notices.set(sessionId, `Renamed "${item.label}" to "${reading.label}".`);
        return;
      case 'note':
        this.#correct(sessionId, {
          op: 'note',
          itemId: item.id,
          note: reading.text,
          via,
          utteranceId,
        });
        this.#notices.set(sessionId, `Added your note to "${item.label}".`);
        return;
    }
  }

  #add(
    sessionId: string,
    text: string,
    cues: Cues,
    observationId: string | null,
    utteranceId: string,
  ) {
    const words = text.trim();
    const label = words.split(/\s+/).slice(0, 5).join(' ');
    const pointer = cues.pointer;
    const item: Item = {
      id: this.#newId('itm'),
      kind: 'note',
      label,
      statement: words,
      grounding:
        pointer !== undefined && observationId !== null
          ? { kind: 'point', observationId, point: pointer.point }
          : { kind: 'scene' },
      confidence: null,
      origin: 'person',
      status: 'confirmed',
      emphasis: false,
    };
    this.#correct(sessionId, { op: 'add', item, via: 'voice', utteranceId });
    this.#notices.set(sessionId, `Added "${label}".`);
  }

  #commit(sessionId: string): void {
    const session = this.#open(sessionId);
    const packageId = this.#newId('ctx');
    const pkg = buildPackage(session, {
      packageId,
      committedAt: this.#now().toISOString(),
      service: this.#deps.service,
    });
    this.#record({
      type: 'context.committed',
      session: sessionId,
      actor: 'person',
      data: { packageId, package: pkg },
    });
    this.#notices.set(sessionId, 'Ready on your Mac. Not sent.');
  }
}

function actionNotice(action: string, label: string): string {
  switch (action) {
    case 'confirm':
      return `Confirmed "${label}".`;
    case 'reject':
      return `Marked "${label}" as not right.`;
    case 'ignore':
      return `Ignoring "${label}".`;
    case 'known':
      return `Noted that you already know "${label}".`;
    case 'matters':
      return `"${label}" matters.`;
    default:
      return `"${label}" is back to a proposal.`;
  }
}

/** One line on what a package holds. */
export function summarize(pkg: ContextPackage): string {
  const count = (verification: string) =>
    pkg.items.filter((item) => item.verification === verification).length;
  const parts = [
    `${count('confirmed') + count('corrected')} confirmed`,
    `${count('accepted')} accepted`,
    `${count('authored')} added`,
    `${pkg.known.length} known`,
    `${pkg.rejected.length} rejected`,
  ];
  return parts.join(', ');
}
