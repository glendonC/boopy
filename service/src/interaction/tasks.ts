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
}
