/**
 * Local task revisions. Every change is a journal event. This projection is not a
 * personal-assistant connection: continuity stays local-only and delivery stays not-sent.
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
  type OpenedData,
  OpenedData as OpenedSchema,
  OpenTask as OpenSchema,
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
  readonly code: 'stale_revision' | 'cancelled' | null;
  readonly taskId: string;
  readonly action: {
    readonly type: UserAction['type'];
    readonly sessionId: string;
    readonly expectedRevision: number;
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
  status: StatusCode;
  attempts: TaskView['attempts'][number][];
  lastRejection: TaskView['lastRejection'];
};

type Fold = { readonly tasks: Map<string, State>; readonly seen: Map<string, Seen> };

export class TaskStore {
  readonly #journal: Journal;

  constructor(journal: Journal) {
    this.#journal = journal;
  }

  get(taskId: string): TaskView | undefined {
    return view(fold(this.#journal.all()).tasks.get(taskId));
  }

  open(input: unknown, at: string): TaskOutcome {
    const parsed = OpenSchema.parse(input);
    At.parse(at);
    const hash = payloadHash(openMaterial(parsed));
    const current = fold(this.#journal.all());
    const prior = current.seen.get(parsed.eventId);
    if (prior) return replay(prior, hash, current.tasks);
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
      {
        type: 'task.opened',
        session: parsed.sessionId,
        actor: 'person',
        data: OpenedSchema.parse(data),
      },
      parsed.eventId,
      at,
    );
    return { status: 'accepted', task: mustGet(this, parsed.taskId) };
  }

  act(input: unknown, at: string): TaskOutcome {
    const parsed = ActSchema.parse(input);
    At.parse(at);
    const hash = payloadHash(actMaterial(parsed));
    const current = fold(this.#journal.all());
    const prior = current.seen.get(parsed.eventId);
    if (prior) return replay(prior, hash, current.tasks);
    const state = current.tasks.get(parsed.taskId);
    if (!state) return { status: 'rejected', code: 'unknown_task', task: null };
    if (state.sessionId !== parsed.sessionId)
      return { status: 'rejected', code: 'session_mismatch', task: present(state) };
    if (state.phase === 'cancelled')
      return this.#rejectAction(parsed, hash, state, 'cancelled', at);
    if (parsed.expectedRevision !== state.revision)
      return this.#rejectAction(parsed, hash, state, 'stale_revision', at);
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
    );
    return { status: 'accepted', task: mustGet(this, parsed.taskId) };
  }

  #rejectAction(
    parsed: ActInput,
    hash: string,
    state: State,
    code: 'stale_revision' | 'cancelled',
    at: string,
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
    );
    return { status: 'rejected', code, task: mustGet(this, parsed.taskId) };
  }

  #append(event: TaskEvent, id: string, at: string): void {
    this.#journal.append(event, id, at);
  }
}

function replay(prior: Seen, hash: string, tasks: Map<string, State>): TaskOutcome {
  if (prior.hash !== hash) return { status: 'rejected', code: 'duplicate_conflict', task: null };
  const task = mustView({ tasks, seen: new Map() }, prior.taskId);
  if (prior.outcome === 'accepted') return { status: 'accepted', task };
  if (prior.code === 'stale_revision' || prior.code === 'cancelled')
    return { status: 'rejected', code: prior.code, task };
  return { status: 'rejected', code: 'duplicate_conflict', task: null };
}

function mustGet(store: TaskStore, taskId: string): TaskView {
  const task = store.get(taskId);
  if (!task) throw new Error('Task projection lost an accepted task.');
  return task;
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
    components: [{ type: 'status', code: state.status }],
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
    check(event, data, 'person', payloadHash(openMaterial(data)));
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
    check(event, data, 'person', payloadHash(actMaterial(data)));
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
    check(event, data, 'person', payloadHash(actMaterial(data)));
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
  throw new Error(`Unhandled task event ${event.type}.`);
}

function actionOf(data: ActionAcceptedData | ActionRejectedData): Seen['action'] {
  return {
    type: data.action.type,
    sessionId: data.sessionId,
    expectedRevision: data.expectedRevision,
  };
}

function applyAction(state: State, data: ActionAcceptedData): void {
  const action = data.action;
  if (action.type === 'voice_reply') {
    state.attempts.push({
      eventId: data.eventId,
      text: action.text,
      recognitionUncertain: action.recognitionUncertain,
      kind: 'practice-attempt',
    });
    state.status = 'not-sent';
  } else if (action.type === 'wrong_subject') {
    state.subjectCorrected = true;
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
  actor: 'person' | 'system',
  hash: string,
): void {
  if (event.actor !== actor || event.session !== data.sessionId || data.payloadSha256 !== hash)
    throw new Error('Task event does not match its payload.');
}

function openMaterial(input: {
  eventId: string;
  taskId: string;
  sessionId: string;
  source: TaskView['source'];
  intent: TaskView['intent'];
  utterance: string;
}) {
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
