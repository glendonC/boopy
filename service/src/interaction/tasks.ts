/**
 * Local task revisions. Every change is a journal event. This projection is not a
 * personal-Bot connection: continuity stays local-only and delivery stays not-sent.
 * A provider result is a labeled local simulator acceptance, never a verified Bot return. A reply
 * from a connection the person named counts only for the exact request it answers, and its author
 * is claimed by the file, never known.
 */
import { timingSafeEqual } from 'node:crypto';
import { sha256 } from '../activity-contract.ts';
import type { Journal, Recorded } from '../journal.ts';
import { MAX_CONNECTION_FILE_BYTES, readTaskReply, renderTaskRequest } from './connection-files.ts';
import {
  type ActInput,
  type ActionAcceptedData,
  ActionAcceptedData as ActionAcceptedSchema,
  type ActionRejectedData,
  ActionRejectedData as ActionRejectedSchema,
  ActInput as ActSchema,
  At,
  type Component,
  ConnectionCreatedData as ConnectionCreatedSchema,
  Connect as ConnectSchema,
  componentProblem,
  type OpenedData,
  OpenedData as OpenedSchema,
  OpenTask as OpenSchema,
  type OpenTask,
  PrepareRequest as PrepareSchema,
  type ProviderAcceptedData,
  ProviderAcceptedData as ProviderAcceptedSchema,
  type ProviderRejectedData,
  ProviderRejectedData as ProviderRejectedSchema,
  type ProviderResult,
  ProviderResult as ProviderSchema,
  payloadHash,
  type ReplyMatchedData,
  ReplyMatchedData as ReplyMatchedSchema,
  type ReplyOutcome,
  type ReplyRejectedData,
  ReplyRejectedData as ReplyRejectedSchema,
  type RequestOutcome,
  RequestPreparedData as RequestPreparedSchema,
  type StatusCode,
  type TaskEvent,
  type TaskOutcome,
  TaskReply,
  type TaskView,
  type UserAction,
} from './contract.ts';

type Seen = {
  readonly hash: string;
  readonly outcome: 'accepted' | 'rejected';
  readonly code: ReplyRejectedData['code'] | null;
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
  /** The person's name for the connection the current parts came back through. */
  reply: string | null;
};

/** A request file prepared for one task revision; the nonce itself is never kept. */
type Request = {
  readonly eventId: string;
  readonly fileSha256: string;
  readonly taskId: string;
  readonly sessionId: string;
  readonly connectionId: string;
  readonly revision: number;
  readonly evidenceIds: readonly string[];
  readonly nonceSha256: string;
  matched: boolean;
};

type Fold = {
  readonly tasks: Map<string, State>;
  readonly seen: Map<string, Seen>;
  readonly requests: Map<string, Request>;
};

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

  /** The person names a connection on the Mac. The same connection again changes nothing. */
  connect(
    input: unknown,
    at: string,
  ):
    | { readonly status: 'accepted' }
    | { readonly status: 'rejected'; readonly code: 'duplicate_conflict' } {
    const parsed = ConnectSchema.parse(input);
    At.parse(at);
    const hash = payloadHash(parsed);
    const prior = this.#connections().get(parsed.connectionId);
    if (prior !== undefined)
      return prior.payloadSha256 === hash
        ? { status: 'accepted' }
        : { status: 'rejected', code: 'duplicate_conflict' };
    if (this.#journal.has(parsed.eventId))
      return { status: 'rejected', code: 'duplicate_conflict' };
    this.#journal.append(
      {
        type: 'connection.created',
        session: parsed.connectionId,
        actor: 'person',
        data: ConnectionCreatedSchema.parse({
          payloadSha256: hash,
          ...parsed,
          channel: 'person-file',
        }),
      },
      parsed.eventId,
      at,
    );
    return { status: 'accepted' };
  }

  /**
   * The request file for a task's current revision, which the person carries to a connection.
   * One request per revision; the journal keeps the file's and the nonce's digests only.
   */
  prepareRequest(input: unknown, at: string): RequestOutcome {
    const parsed = PrepareSchema.parse(input);
    At.parse(at);
    const current = this.#fold();
    const refused = (
      code: Extract<RequestOutcome, { status: 'rejected' }>['code'],
      requestId: string | null = null,
    ) => ({ status: 'rejected', code, requestId }) as const;
    const earlier = current.requests.get(parsed.requestId);
    if (earlier !== undefined || this.#journal.has(parsed.eventId)) {
      // An identical retry gets its file again, so a file lost after the journal append is not
      // lost for good. The nonce is checked against the digest the journal kept.
      if (
        earlier === undefined ||
        earlier.eventId !== parsed.eventId ||
        earlier.taskId !== parsed.taskId ||
        earlier.sessionId !== parsed.sessionId ||
        earlier.connectionId !== parsed.connectionId ||
        !timingSafeEqual(
          Buffer.from(sha256(parsed.nonce), 'hex'),
          Buffer.from(earlier.nonceSha256, 'hex'),
        )
      )
        return refused('duplicate_conflict');
      const state = requireState(current.tasks, earlier.taskId, earlier.sessionId);
      const again = state.revision === earlier.revision ? requestFile(state, parsed) : null;
      return again === null || again.fileSha256 !== earlier.fileSha256
        ? refused('request_unavailable', parsed.requestId)
        : { status: 'accepted', requestId: parsed.requestId, ...again };
    }
    const state = current.tasks.get(parsed.taskId);
    if (state === undefined) return refused('unknown_task');
    if (state.sessionId !== parsed.sessionId) return refused('session_mismatch');
    if (!this.#connections().has(parsed.connectionId)) return refused('unknown_connection');
    if (state.phase === 'cancelled') return refused('cancelled');
    for (const [requestId, request] of current.requests)
      if (request.taskId === parsed.taskId && request.revision === state.revision)
        return refused('request_exists', requestId);
    const rendered = requestFile(state, parsed);
    const annotation = state.providerComponents.find((part) => part.type === 'annotation');
    if (rendered === null || annotation?.type !== 'annotation')
      return refused('request_unavailable');
    const facts = {
      eventId: parsed.eventId,
      requestId: parsed.requestId,
      taskId: parsed.taskId,
      sessionId: parsed.sessionId,
      connectionId: parsed.connectionId,
      revision: state.revision,
      evidenceIds: annotation.evidenceIds,
      fileSha256: rendered.fileSha256,
      nonceSha256: sha256(parsed.nonce),
    };
    this.#append(
      {
        type: 'task.request-prepared',
        session: parsed.sessionId,
        actor: 'person',
        data: RequestPreparedSchema.parse({ payloadSha256: payloadHash(facts), ...facts }),
      },
      parsed.eventId,
      at,
      current,
    );
    return { status: 'accepted', requestId: parsed.requestId, ...rendered };
  }

  /**
   * A reply file the person brought back. It counts only for the exact request it answers, in
   * this order: a prepared request, a valid envelope, the nonce, the task and source, a first
   * reply, an open task at the request's revision, and parts the contract allows. A refusal is
   * journaled by the file's digest and a code and changes nothing; a file that cannot be read or
   * names no prepared request journals nothing. The same file again gives the recorded outcome.
   */
  matchReply(content: string, at: string): ReplyOutcome {
    At.parse(at);
    const read = readTaskReply(content);
    if (read === null) return { status: 'rejected', code: 'reply_unreadable', task: null };
    const current = this.#fold();
    const id = `evt_reply_${read.fileSha256.slice(0, 48)}`;
    const prior = current.seen.get(id);
    if (prior !== undefined) {
      const task = mustView(current, prior.taskId);
      return prior.outcome === 'accepted' || prior.code === null
        ? { status: 'accepted', task }
        : { status: 'rejected', code: prior.code, task };
    }
    const requestId = read.value.requestId;
    const request = typeof requestId === 'string' ? current.requests.get(requestId) : undefined;
    if (typeof requestId !== 'string' || request === undefined)
      return { status: 'rejected', code: 'unknown_request', task: null };
    const state = requireState(current.tasks, request.taskId, request.sessionId);
    const refuse = (code: ReplyRejectedData['code']) =>
      this.#rejectReply(id, requestId, read.fileSha256, state, code, at, current);
    const parsed = TaskReply.safeParse(read.value);
    if (!parsed.success) return refuse('reply_invalid');
    const reply = parsed.data;
    const nonce = Buffer.from(sha256(reply.nonce), 'hex');
    if (!timingSafeEqual(nonce, Buffer.from(request.nonceSha256, 'hex')))
      return refuse('nonce_mismatch');
    if (reply.taskId !== request.taskId || !sameSource(reply.source, state.source))
      return refuse('source_mismatch');
    if (request.matched) return refuse('duplicate_conflict');
    if (state.phase === 'cancelled') return refuse('cancelled');
    if (reply.baseTaskRevision !== request.revision || request.revision !== state.revision)
      return refuse('stale_revision');
    const parts = [...kept(state.providerComponents), ...reply.components];
    if (
      !reply.components.some((part) => part.type === 'dialogue') ||
      componentProblem(parts, state.source.sourceId, new Set(request.evidenceIds)) !== null
    )
      return refuse('reply_invalid');
    const connection = this.#connections().get(request.connectionId);
    if (connection === undefined) throw new Error('A prepared request lost its connection.');
    const facts = {
      requestId,
      taskId: request.taskId,
      sessionId: request.sessionId,
      connectionId: request.connectionId,
      label: connection.label,
      fileSha256: read.fileSha256,
      baseRevision: state.revision,
      components: reply.components,
    };
    const data: ReplyMatchedData = {
      payloadSha256: payloadHash(facts),
      ...facts,
      revision: state.revision + 1,
      authorship: 'claimed-by-file',
      outcome: 'accepted',
    };
    this.#append(
      {
        type: 'task.reply-matched',
        session: request.sessionId,
        actor: 'person',
        data: ReplyMatchedSchema.parse(data),
      },
      id,
      at,
      current,
    );
    return { status: 'accepted', task: mustView(current, request.taskId) };
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

  #rejectReply(
    id: string,
    requestId: string,
    fileSha256: string,
    state: State,
    code: ReplyRejectedData['code'],
    at: string,
    current: Fold,
  ): ReplyOutcome {
    const facts = {
      requestId,
      taskId: state.taskId,
      sessionId: state.sessionId,
      fileSha256,
      revision: state.revision,
      code,
    };
    const data: ReplyRejectedData = {
      payloadSha256: payloadHash(facts),
      ...facts,
      outcome: 'rejected',
    };
    this.#append(
      {
        type: 'task.reply-rejected',
        session: state.sessionId,
        actor: 'person',
        data: ReplyRejectedSchema.parse(data),
      },
      id,
      at,
      current,
    );
    return { status: 'rejected', code, task: mustView(current, state.taskId) };
  }

  /** The connections the person named, by id. */
  #connections(): Map<string, { readonly label: string; readonly payloadSha256: string }> {
    const connections = new Map<string, { label: string; payloadSha256: string }>();
    for (const event of this.#journal.withTypePrefix('connection.')) {
      const data = ConnectionCreatedSchema.parse(event.data);
      const { payloadSha256, ...facts } = data;
      if (
        event.type !== 'connection.created' ||
        event.actor !== 'person' ||
        event.session !== data.connectionId ||
        payloadHash({
          eventId: facts.eventId,
          connectionId: facts.connectionId,
          label: facts.label,
        }) !== payloadSha256 ||
        connections.has(data.connectionId)
      )
        throw new Error('Connection event does not match its payload.');
      connections.set(data.connectionId, { label: data.label, payloadSha256 });
    }
    return connections;
  }

  /** Task events only, read once per call. */
  #fold(): Fold {
    return fold(this.#journal.withTypePrefix('task.'));
  }

  /** Appends an event and applies it to the fold in hand, so the new view needs no new read. */
  #append(event: TaskEvent, id: string, at: string, current: Fold): void {
    apply(this.#journal.append(event, id, at), current);
  }
}

function replay(prior: Seen, hash: string, tasks: Map<string, State>): TaskOutcome {
  if (prior.hash !== hash) return CONFLICT;
  const task = mustView({ tasks, seen: new Map(), requests: new Map() }, prior.taskId);
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
    ...(state.reply === null ? {} : { reply: { connection: state.reply } }),
  };
}

function fold(events: readonly Recorded[]): Fold {
  const current: Fold = { tasks: new Map(), seen: new Map(), requests: new Map() };
  for (const event of events) {
    if (!event.type.startsWith('task.')) continue;
    apply(event, current);
  }
  return current;
}

function apply(event: Recorded, { tasks, seen, requests }: Fold): void {
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
      reply: null,
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
    state.reply = null;
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
  if (event.type === 'task.request-prepared') {
    const data = RequestPreparedSchema.parse(event.data);
    const state = requireState(tasks, data.taskId, data.sessionId);
    const { payloadSha256, ...facts } = data;
    check(event, data, ['person'], payloadHash(facts));
    if (data.revision !== state.revision || requests.has(data.requestId))
      throw new Error('Request does not follow the journal.');
    requests.set(data.requestId, {
      eventId: data.eventId,
      fileSha256: data.fileSha256,
      taskId: data.taskId,
      sessionId: data.sessionId,
      connectionId: data.connectionId,
      revision: data.revision,
      evidenceIds: data.evidenceIds,
      nonceSha256: data.nonceSha256,
      matched: false,
    });
    seen.set(event.id, {
      hash: payloadSha256,
      outcome: 'accepted',
      code: null,
      taskId: data.taskId,
      action: null,
    });
    return;
  }
  if (event.type === 'task.reply-matched') {
    const data = ReplyMatchedSchema.parse(event.data);
    const state = requireState(tasks, data.taskId, data.sessionId);
    const { payloadSha256, revision, authorship, outcome, ...facts } = data;
    check(event, data, ['person'], payloadHash(facts));
    const request = requests.get(data.requestId);
    if (
      request === undefined ||
      request.matched ||
      request.taskId !== data.taskId ||
      request.revision !== state.revision ||
      data.baseRevision !== state.revision ||
      revision !== state.revision + 1
    )
      throw new Error('Reply does not follow the journal.');
    request.matched = true;
    state.providerComponents = [
      ...kept(state.providerComponents),
      ...structuredClone(data.components),
    ];
    state.status = 'not-sent';
    state.revision = revision;
    state.reply = data.label;
    state.lastRejection = null;
    seen.set(event.id, {
      hash: payloadSha256,
      outcome: 'accepted',
      code: null,
      taskId: data.taskId,
      action: null,
    });
    return;
  }
  if (event.type === 'task.reply-rejected') {
    const data = ReplyRejectedSchema.parse(event.data);
    const state = requireState(tasks, data.taskId, data.sessionId);
    const { payloadSha256, outcome, ...facts } = data;
    check(event, data, ['person'], payloadHash(facts));
    if (!requests.has(data.requestId) || data.revision !== state.revision)
      throw new Error('Rejected reply changed the revision.');
    state.lastRejection = { eventId: event.id, code: data.code };
    seen.set(event.id, {
      hash: payloadSha256,
      outcome: 'rejected',
      code: data.code,
      taskId: data.taskId,
      action: null,
    });
    return;
  }
  throw new Error(`Unhandled task event ${event.type}.`);
}

/**
 * The request file for a task at its current revision, or null when the task has no chip to ask
 * about or the file would be larger than 16 KiB. The task store does not know the model's
 * confidence, so the file says it is unknown.
 */
function requestFile(
  state: State,
  request: { readonly requestId: string; readonly nonce: string },
) {
  const annotation = state.providerComponents.find((part) => part.type === 'annotation');
  const line = state.providerComponents.find((part) => part.type === 'dialogue');
  if (annotation?.type !== 'annotation') return null;
  const rendered = renderTaskRequest({
    requestId: request.requestId,
    taskId: state.taskId,
    revision: state.revision,
    source: state.source,
    nonce: request.nonce,
    utterance: state.utterance,
    subject: annotation.text,
    subjectConfidence: null,
    boopyLine: line?.type === 'dialogue' ? line.text : null,
    answers: state.attempts,
    evidenceIds: annotation.evidenceIds,
  });
  return Buffer.byteLength(rendered.file) > MAX_CONNECTION_FILE_BYTES ? null : rendered;
}

/** What a reply leaves in place: the subject and its chip stay Boopy's. */
function kept(components: readonly Component[]): Component[] {
  return components.filter((part) => part.type === 'subject' || part.type === 'annotation');
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
