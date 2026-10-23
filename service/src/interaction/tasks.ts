/**
 * Local task revisions. Every change is a journal event. This projection is not a
 * personal-Bot connection: continuity stays local-only and delivery stays not-sent.
 * A provider result is a labeled local simulator acceptance, never a verified Bot return.
 */
import type { Journal, Recorded } from '../journal.ts';
import {
  type ActInput,
  type ActionAcceptedData,
  ActionAcceptedData as ActionAcceptedSchema,
  type ActionRejectedData,
  ActionRejectedData as ActionRejectedSchema,
  ActInput as ActSchema,
  At,
  type Component,
  type OpenedData,
  OpenedData as OpenedSchema,
  OpenTask as OpenSchema,
  type OpenTask,
  type ProviderAcceptedData,
  ProviderAcceptedData as ProviderAcceptedSchema,
  type ProviderRejectedData,
  ProviderRejectedData as ProviderRejectedSchema,
  type ProviderResult,
  ProviderResult as ProviderSchema,
  payloadHash,
  type StatusCode,
  type TaskEvent,
  type TaskOutcome,
  type TaskView,
  type UserAction,
} from './contract.ts';

type Seen = {
  readonly hash: string;
  readonly outcome: 'accepted' | 'rejected';
  readonly code: 'stale_revision' | 'cancelled' | 'source_mismatch' | null;
  readonly taskId: string;
  /** For a person's action: what a retry can be matched on without the action's own payload. */
  readonly action: {
    readonly type: UserAction['type'];
    readonly sessionId: string;
    readonly expectedRevision: number;
    /** The SHA-256 of a spoken answer's audio, when the answer came with audio. */
    readonly audioSha256: string | null;
  } | null;
};

type State = {
  taskId: string;
  sessionId: string;
  revision: number;
  source: TaskView['source'];
  intent: TaskView['intent'];
  utterance: string;
  phase: 'open' | 'cancelled';
  subjectCorrected: boolean;
  providerComponents: Component[];
  status: StatusCode;
  attempts: TaskView['attempts'][number][];
  lastRejection: TaskView['lastRejection'];
};

type Fold = { readonly tasks: Map<string, State>; readonly seen: Map<string, Seen> };

type Rejected = Extract<TaskOutcome, { status: 'rejected' }>;

const CONFLICT: Rejected = { status: 'rejected', code: 'duplicate_conflict', task: null };
const UNKNOWN: Rejected = { status: 'rejected', code: 'unknown_task', task: null };

/** A refusal inside a journal transaction. Throwing it rolls the transaction back. */
class Refusal extends Error {
  readonly outcome: Rejected;

  constructor(outcome: Rejected) {
    super('Refused inside a journal transaction.');
    this.outcome = outcome;
  }
}

export class TaskStore {
  readonly #journal: Journal;

  constructor(journal: Journal) {
    this.#journal = journal;
  }

  get(taskId: string): TaskView | undefined {
    return view(this.#fold().tasks.get(taskId));
  }

  /** The task opened for this session, the earliest when there are several. */
  forSession(sessionId: string): TaskView | undefined {
    for (const state of this.#fold().tasks.values())
      if (state.sessionId === sessionId) return present(state);
    return undefined;
  }

  /**
   * Opens a task from the person's turn and records its first result in one journal
   * transaction: both events are kept, or neither is. The system is the opening's actor; the
   * utterance stays the person's words. A task with the same opening that is still at revision 0
   * gets the same result.
   */
  openWithResult(open: unknown, result: unknown, at: string): TaskOutcome {
    const opening = OpenSchema.parse(open);
    const first = ProviderSchema.parse(result);
    At.parse(at);
    if (
      first.taskId !== opening.taskId ||
      first.sessionId !== opening.sessionId ||
      first.baseRevision !== 0 ||
      !sameSource(first.source, opening.source)
    )
      throw new Error('A first result names the task it opens, at revision 0.');
    const current = this.#fold();
    const prior = current.seen.get(first.resultId);
    const state = current.tasks.get(opening.taskId);
    if (state !== undefined) {
      if (state.sessionId !== opening.sessionId)
        return { status: 'rejected', code: 'task_exists', task: null };
      if (prior !== undefined)
        return replay(prior, payloadHash(providerMaterial(first)), current.tasks);
      if (
        state.revision !== 0 ||
        state.intent !== opening.intent ||
        state.utterance !== opening.utterance ||
        !sameSource(state.source, opening.source)
      )
        return { status: 'rejected', code: 'task_exists', task: present(state) };
      return this.#receive(first, at, current);
    }
    if (prior !== undefined || current.seen.has(opening.eventId)) return CONFLICT;
    try {
      return this.#journal.transaction(() => {
        const opened = this.#open(opening, at, 'system', current);
        if (opened.status === 'rejected') throw new Refusal(opened);
        const received = this.#receive(first, at, current);
        if (received.status === 'rejected') throw new Refusal(received);
        return received;
      });
    } catch (failure) {
      // The fold in hand saw the rolled-back events, so a refusal carries no view.
      if (failure instanceof Refusal) return { ...failure.outcome, task: null };
      throw failure;
    }
  }

  /**
   * What the Mac answers before it transcribes a spoken answer, appending nothing: the outcome
   * already recorded under this event id, or a refusal that needs no words. Undefined when the
   * answer may be transcribed. A recorded answer replays only for the same task, session,
   * revision and audio.
   */
  checkAnswer(input: {
    readonly eventId: string;
    readonly taskId: string;
    readonly sessionId: string;
    readonly expectedRevision: number;
    readonly audioSha256: string;
  }): TaskOutcome | undefined {
    const current = this.#fold();
    const prior = current.seen.get(input.eventId);
    if (prior !== undefined) {
      const answer = prior.action;
      return answer?.type === 'voice_reply' &&
        prior.taskId === input.taskId &&
        answer.sessionId === input.sessionId &&
        answer.expectedRevision === input.expectedRevision &&
        answer.audioSha256 === input.audioSha256
        ? replay(prior, prior.hash, current.tasks)
        : CONFLICT;
    }
    if (this.#journal.has(input.eventId)) return CONFLICT;
    const state = current.tasks.get(input.taskId);
    if (state === undefined) return UNKNOWN;
    if (state.sessionId !== input.sessionId)
      return { status: 'rejected', code: 'session_mismatch', task: present(state) };
    if (state.phase === 'cancelled')
      return { status: 'rejected', code: 'cancelled', task: present(state) };
    if (state.revision !== input.expectedRevision)
      return { status: 'rejected', code: 'stale_revision', task: present(state) };
    // Only a task whose current parts ask for a spoken answer takes one. Any change to the parts
    // moves the revision, so an answer checked here and recorded after transcription stays safe.
    if (!state.providerComponents.some((component) => component.type === 'voice_reply'))
      return { status: 'rejected', code: 'answer_not_offered', task: present(state) };
    return undefined;
  }

  open(input: unknown, at: string): TaskOutcome {
    const parsed = OpenSchema.parse(input);
    At.parse(at);
    return this.#open(parsed, at, 'person', this.#fold());
  }

  act(input: unknown, at: string): TaskOutcome {
    const parsed = ActSchema.parse(input);
    At.parse(at);
    const hash = payloadHash(actMaterial(parsed));
    const current = this.#fold();
    const prior = current.seen.get(parsed.eventId);
    if (prior) return replay(prior, hash, current.tasks);
    if (this.#journal.has(parsed.eventId)) return CONFLICT;
    const state = current.tasks.get(parsed.taskId);
    if (!state) return UNKNOWN;
    if (state.sessionId !== parsed.sessionId)
      return { status: 'rejected', code: 'session_mismatch', task: present(state) };
    if (state.phase === 'cancelled')
      return this.#rejectAction(parsed, hash, state, 'cancelled', at, current);
    if (parsed.expectedRevision !== state.revision)
      return this.#rejectAction(parsed, hash, state, 'stale_revision', at, current);
    const data: ActionAcceptedData = {
      payloadSha256: hash,
      eventId: parsed.eventId,
      taskId: parsed.taskId,
      sessionId: parsed.sessionId,
      expectedRevision: parsed.expectedRevision,
      revision: state.revision + 1,
      action: parsed.action,
      outcome: 'accepted',
    };
    this.#append(
      {
        type: 'task.action-accepted',
        session: parsed.sessionId,
        actor: 'person',
        data: ActionAcceptedSchema.parse(data),
      },
      parsed.eventId,
      at,
      current,
    );
    return { status: 'accepted', task: mustView(current, parsed.taskId) };
  }

  receive(input: unknown, at: string): TaskOutcome {
    const parsed = ProviderSchema.parse(input);
    At.parse(at);
    return this.#receive(parsed, at, this.#fold());
  }

  #open(parsed: OpenTask, at: string, actor: 'person' | 'system', current: Fold): TaskOutcome {
    const hash = payloadHash(openMaterial(parsed));
    const prior = current.seen.get(parsed.eventId);
    if (prior) return replay(prior, hash, current.tasks);
    if (this.#journal.has(parsed.eventId)) return CONFLICT;
    if (current.tasks.has(parsed.taskId))
      return { status: 'rejected', code: 'task_exists', task: mustView(current, parsed.taskId) };
    const data: OpenedData = {
      payloadSha256: hash,
      eventId: parsed.eventId,
      taskId: parsed.taskId,
      sessionId: parsed.sessionId,
      source: parsed.source,
      intent: parsed.intent,
      utterance: parsed.utterance,
      revision: 0,
      outcome: 'accepted',
    };
    this.#append(
      { type: 'task.opened', session: parsed.sessionId, actor, data: OpenedSchema.parse(data) },
      parsed.eventId,
      at,
      current,
    );
    return { status: 'accepted', task: mustView(current, parsed.taskId) };
  }

  #receive(parsed: ProviderResult, at: string, current: Fold): TaskOutcome {
    const hash = payloadHash(providerMaterial(parsed));
    const prior = current.seen.get(parsed.resultId);
    if (prior) return replay(prior, hash, current.tasks);
    if (this.#journal.has(parsed.resultId)) return CONFLICT;
    const state = current.tasks.get(parsed.taskId);
    if (!state) return UNKNOWN;
    if (state.sessionId !== parsed.sessionId)
      return { status: 'rejected', code: 'session_mismatch', task: present(state) };
    const code =
      state.phase === 'cancelled'
        ? 'cancelled'
        : !sameSource(state.source, parsed.source)
          ? 'source_mismatch'
          : parsed.baseRevision !== state.revision
            ? 'stale_revision'
            : null;
    if (code) return this.#rejectProvider(parsed, hash, state, code, at, current);
    const data: ProviderAcceptedData = {
      payloadSha256: hash,
      resultId: parsed.resultId,
      taskId: parsed.taskId,
      sessionId: parsed.sessionId,
      baseRevision: parsed.baseRevision,
      revision: state.revision + 1,
      source: parsed.source,
      evidenceIds: parsed.evidenceIds,
      components: parsed.components,
      simulator: true,
      outcome: 'accepted',
    };
    this.#append(
      {
        type: 'task.provider-accepted',
        session: parsed.sessionId,
        actor: 'system',
        data: ProviderAcceptedSchema.parse(data),
      },
      parsed.resultId,
      at,
      current,
    );
    return { status: 'accepted', task: mustView(current, parsed.taskId) };
  }

  #rejectAction(
    parsed: ActInput,
    hash: string,
    state: State,
    code: 'stale_revision' | 'cancelled',
    at: string,
    current: Fold,
  ): TaskOutcome {
    const data: ActionRejectedData = {
      payloadSha256: hash,
      eventId: parsed.eventId,
      taskId: parsed.taskId,
      sessionId: parsed.sessionId,
      expectedRevision: parsed.expectedRevision,
      revision: state.revision,
      action: parsed.action,
      code,
      outcome: 'rejected',
    };
    this.#append(
      {
        type: 'task.action-rejected',
        session: parsed.sessionId,
        actor: 'person',
        data: ActionRejectedSchema.parse(data),
      },
      parsed.eventId,
      at,
      current,
    );
    return { status: 'rejected', code, task: mustView(current, parsed.taskId) };
  }

  #rejectProvider(
    parsed: ProviderResult,
    hash: string,
    state: State,
    code: 'stale_revision' | 'cancelled' | 'source_mismatch',
    at: string,
    current: Fold,
  ): TaskOutcome {
    const data: ProviderRejectedData = {
      payloadSha256: hash,
      resultId: parsed.resultId,
      taskId: parsed.taskId,
      sessionId: parsed.sessionId,
      baseRevision: parsed.baseRevision,
      revision: state.revision,
      source: parsed.source,
      evidenceIds: parsed.evidenceIds,
      components: parsed.components,
      code,
      outcome: 'rejected',
      simulator: true,
    };
    this.#append(
      {
        type: 'task.provider-rejected',
        session: parsed.sessionId,
        actor: 'system',
        data: ProviderRejectedSchema.parse(data),
      },
      parsed.resultId,
      at,
      current,
    );
    return { status: 'rejected', code, task: mustView(current, parsed.taskId) };
  }

  /** Task events only, read once per call. */
  #fold(): Fold {
    return fold(this.#journal.withTypePrefix('task.'));
  }

  /** Appends an event and applies it to the fold in hand, so the new view needs no new read. */
  #append(event: TaskEvent, id: string, at: string, current: Fold): void {
    apply(this.#journal.append(event, id, at), current.tasks, current.seen);
  }
}

function replay(prior: Seen, hash: string, tasks: Map<string, State>): TaskOutcome {
  if (prior.hash !== hash) return CONFLICT;
  const task = mustView({ tasks, seen: new Map() }, prior.taskId);
  if (prior.outcome === 'accepted') return { status: 'accepted', task };
  if (
    prior.code === 'stale_revision' ||
    prior.code === 'cancelled' ||
    prior.code === 'source_mismatch'
  )
    return { status: 'rejected', code: prior.code, task };
  return CONFLICT;
}

function mustView(foldResult: Fold, taskId: string): TaskView {
  const task = view(foldResult.tasks.get(taskId));
  if (!task) throw new Error('Task projection lost an accepted task.');
  return task;
}

function view(state: State | undefined): TaskView | undefined {
  if (!state) return undefined;
  return present(state);
}

function present(state: State): TaskView {
  return {
    taskId: state.taskId,
    sessionId: state.sessionId,
    revision: state.revision,
    source: state.source,
    intent: state.intent,
    utterance: state.utterance,
    phase: state.phase,
    continuity: 'local-only',
    delivery: 'not-sent',
    subjectCorrected: state.subjectCorrected,
    components: [...state.providerComponents, { type: 'status', code: state.status }],
    attempts: state.attempts.map((attempt) => ({ ...attempt })),
    lastRejection: state.lastRejection,
  };
}

function fold(events: readonly Recorded[]): Fold {
  const tasks = new Map<string, State>();
  const seen = new Map<string, Seen>();
  for (const event of events) {
    if (!event.type.startsWith('task.')) continue;
    apply(event, tasks, seen);
  }
  return { tasks, seen };
}

function apply(event: Recorded, tasks: Map<string, State>, seen: Map<string, Seen>): void {
  if (event.type === 'task.opened') {
    const data = OpenedSchema.parse(event.data);
    check(event, data, ['person', 'system'], payloadHash(openMaterial(data)));
    if (tasks.has(data.taskId)) throw new Error('Duplicate task open.');
    tasks.set(data.taskId, {
      taskId: data.taskId,
      sessionId: data.sessionId,
      revision: 0,
      source: data.source,
      intent: data.intent,
      utterance: data.utterance,
      phase: 'open',
      subjectCorrected: false,
      providerComponents: [],
      status: 'not-sent',
      attempts: [],
      lastRejection: null,
    });
    seen.set(event.id, {
      hash: data.payloadSha256,
      outcome: 'accepted',
      code: null,
      taskId: data.taskId,
      action: null,
    });
    return;
  }
  if (event.type === 'task.action-accepted') {
    const data = ActionAcceptedSchema.parse(event.data);
    const state = requireState(tasks, data.taskId, data.sessionId);
    check(event, data, ['person'], payloadHash(actMaterial(data)));
    if (data.expectedRevision !== state.revision || data.revision !== state.revision + 1)
      throw new Error('Action revision does not follow the journal.');
    applyAction(state, data);
    seen.set(event.id, {
      hash: data.payloadSha256,
      outcome: 'accepted',
      code: null,
      taskId: data.taskId,
      action: actionOf(data),
    });
    return;
  }
  if (event.type === 'task.action-rejected') {
    const data = ActionRejectedSchema.parse(event.data);
    const state = requireState(tasks, data.taskId, data.sessionId);
    check(event, data, ['person'], payloadHash(actMaterial(data)));
    if (data.revision !== state.revision) throw new Error('Rejected action changed the revision.');
    state.lastRejection = { eventId: data.eventId, code: data.code };
    seen.set(event.id, {
      hash: data.payloadSha256,
      outcome: 'rejected',
      code: data.code,
      taskId: data.taskId,
      action: actionOf(data),
    });
    return;
  }
  if (event.type === 'task.provider-accepted') {
    const data = ProviderAcceptedSchema.parse(event.data);
    const state = requireState(tasks, data.taskId, data.sessionId);
    check(event, data, ['system'], payloadHash(providerMaterial(data)));
    if (data.baseRevision !== state.revision || data.revision !== state.revision + 1)
      throw new Error('Provider revision does not follow the journal.');
    if (!sameSource(state.source, data.source)) throw new Error('Provider replaced the source.');
    state.providerComponents = structuredClone(data.components);
    state.status = 'not-sent';
    state.revision = data.revision;
    seen.set(event.id, {
      hash: data.payloadSha256,
      outcome: 'accepted',
      code: null,
      taskId: data.taskId,
      action: null,
    });
    return;
  }
  if (event.type === 'task.provider-rejected') {
    const data = ProviderRejectedSchema.parse(event.data);
    const state = requireState(tasks, data.taskId, data.sessionId);
    check(event, data, ['system'], payloadHash(providerMaterial(data)));
    if (data.revision !== state.revision)
      throw new Error('Rejected provider result changed the revision.');
    state.lastRejection = { eventId: data.resultId, code: data.code };
    seen.set(event.id, {
      hash: data.payloadSha256,
      outcome: 'rejected',
      code: data.code,
      taskId: data.taskId,
      action: null,
    });
    return;
  }
  throw new Error(`Unhandled task event ${event.type}.`);
}

function actionOf(data: ActionAcceptedData | ActionRejectedData): Seen['action'] {
  return {
    type: data.action.type,
    sessionId: data.sessionId,
    expectedRevision: data.expectedRevision,
    audioSha256: data.action.type === 'voice_reply' ? (data.action.audioSha256 ?? null) : null,
  };
}

function applyAction(state: State, data: ActionAcceptedData): void {
  const action = data.action;
  if (action.type === 'voice_reply') {
    // The attempt keeps its shape: audio provenance stays in the journal, not in the view.
    state.attempts.push({
      eventId: data.eventId,
      text: action.text,
      recognitionUncertain: action.recognitionUncertain,
      kind: 'practice-attempt',
    });
    state.status = 'not-sent';
  } else if (action.type === 'wrong_subject') {
    state.subjectCorrected = true;
    state.providerComponents = [];
    state.status = 'wrong-item';
  } else if (action.type === 'save_for_later') {
    state.status = 'continue-later';
  } else if (action.type === 'retry') {
    state.status = 'try-again';
  } else {
    state.phase = 'cancelled';
    state.status = 'continue-later';
  }
  state.revision = data.revision;
  state.lastRejection = null;
}

function requireState(tasks: Map<string, State>, taskId: string, sessionId: string): State {
  const state = tasks.get(taskId);
  if (!state || state.sessionId !== sessionId) throw new Error('Task event has no open task.');
  return state;
}

function check(
  event: Recorded,
  data: { sessionId: string; payloadSha256: string },
  actors: readonly ('person' | 'system')[],
  hash: string,
): void {
  if (
    !(actors as readonly string[]).includes(event.actor) ||
    event.session !== data.sessionId ||
    data.payloadSha256 !== hash
  )
    throw new Error('Task event does not match its payload.');
}

function sameSource(left: TaskView['source'], right: TaskView['source']): boolean {
  return (
    left.sourceId === right.sourceId &&
    left.sourceRevision === right.sourceRevision &&
    left.sha256 === right.sha256
  );
}

function openMaterial(input: OpenTask | OpenedData) {
  return {
    eventId: input.eventId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    source: input.source,
    intent: input.intent,
    utterance: input.utterance,
  };
}

function actMaterial(input: ActInput | ActionAcceptedData | ActionRejectedData) {
  return {
    eventId: input.eventId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    expectedRevision: input.expectedRevision,
    action: input.action,
  };
}

function providerMaterial(input: {
  resultId: string;
  taskId: string;
  sessionId: string;
  baseRevision: number;
  source: ProviderResult['source'];
  evidenceIds: readonly string[];
  components: readonly Component[];
}) {
  return {
    resultId: input.resultId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    baseRevision: input.baseRevision,
    source: input.source,
    evidenceIds: input.evidenceIds,
    components: input.components,
  };
}
