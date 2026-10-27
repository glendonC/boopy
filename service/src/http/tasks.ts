import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { type Boopy, BoopyError } from '../boopy.ts';
import type { GrokBotMoments } from '../grok-bot.ts';
import {
  Connect,
  ConnectionId,
  EventId,
  personLine,
  type ReplyOutcome,
  RequestId,
  type RequestOutcome,
  Revision,
  SessionId,
  TaskId,
  type TaskOutcome,
  type TaskView,
} from '../interaction/contract.ts';
import { assessAnswer, languageName } from '../interaction/practice.ts';
import {
  correctionResult,
  type PracticePick,
  practiceResult,
  standIn,
} from '../interaction/stand-in.ts';
import type { TaskStore } from '../interaction/tasks.ts';
import { practiceRows, recallPractice } from '../memory/practice.ts';
import { matchKey } from '../references/wikidata.ts';
import {
  type PracticeRow,
  type PracticeStageResult,
  type PracticeTable,
  TermPickRequest,
  type TermPickResult,
  ZetarisPracticeError,
} from '../references/zetaris.ts';

/**
 * A GET body larger than this is refused unread, and so is a larger open or action body. Task
 * claims are small JSON objects. An answer carries audio, so it keeps the headset's limit.
 */
const BODY_CAP = 16 * 1024;

const OpenRequest = z.strictObject({ eventId: EventId, taskId: TaskId });

/** An answer is audio only: the headset does not type. */
const AnswerRequest = z.strictObject({
  eventId: EventId,
  sessionId: SessionId,
  expectedRevision: Revision,
  speech: z.strictObject({ wav: z.string().min(1) }),
});

/** A spoken answer goes to the answers route, so voice_reply is not an action here. */
const ActionRequest = z.strictObject({
  eventId: EventId,
  sessionId: SessionId,
  expectedRevision: Revision,
  action: z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('wrong_subject') }),
    z.strictObject({ type: z.literal('save_for_later') }),
    z.strictObject({ type: z.literal('retry') }),
    z.strictObject({ type: z.literal('cancel') }),
  ]),
});

const REFUSALS = {
  unknown_task: [404, 'No such task.'],
  session_mismatch: [409, 'This task belongs to another session.'],
  task_exists: [409, 'This task id belongs to another task.'],
  duplicate_conflict: [409, 'This event id was already used for something else.'],
  stale_revision: [409, 'This task has changed. Read it again before acting.'],
  cancelled: [409, 'This task is closed.'],
  source_mismatch: [409, 'This result names another source.'],
  answer_not_offered: [409, 'This task does not ask for an answer.'],
} as const;

const UNKNOWN: TaskOutcome = { status: 'rejected', code: 'unknown_task', task: null };
const CONFLICT: TaskOutcome = { status: 'rejected', code: 'duplicate_conflict', task: null };

/** A spoken answer as the store checks and records it: the change and its audio digest. */
type Answer = {
  readonly eventId: string;
  readonly taskId: string;
  readonly sessionId: string;
  readonly expectedRevision: number;
  readonly audioSha256: string;
};

/**
 * Zetaris on this Mac as the task routes use it: one fixed term pick at a task's opening and one
 * rewrite of the practice table after an assessed answer. Off unless the service builds it.
 */
export type PracticeLink = {
  readonly table: PracticeTable;
  readonly timeoutMs: number;
  readonly pick: (request: TermPickRequest, signal: AbortSignal) => Promise<TermPickResult>;
  readonly stage: (
    rows: readonly PracticeRow[],
    signal: AbortSignal,
  ) => Promise<PracticeStageResult>;
};

type Planned = NonNullable<ReturnType<typeof standIn>> & { readonly retrieval?: unknown };

/** How long an opening waits for its moment's delivery to start before it answers anyway. */
const OPENING_WAIT_MS = 3000;
/**
 * An opening answers by this long after its request came in, so a slow pick eats into the wait
 * and never into the headset's own 10 s limit.
 */
const OPENING_DEADLINE_MS = 6000;

/** Settles when the work does or when the time is up, whichever comes first. */
async function within(work: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([work, new Promise<void>((resolve) => (timer = setTimeout(resolve, ms)))]);
  clearTimeout(timer);
}

/**
 * The headset's task routes. Every view says local-only and not-sent: nothing here reaches the
 * person's own assistant. The one result a capture gets is a labeled local stand-in projected from
 * Boopy's own turn. Under the person's practice goal, with a practice link, that result carries the
 * outside term for Boopy's guess from one Zetaris pick, and an answer is assessed against it.
 * Reading a task only reads the journal. With the person's own Grok Bot named, each opening and
 * each assessed answer is also sent there as a moment (an opening waits up to 3 s for its send to
 * start, and answers by 6 s after its request), and a view says sentTo only once a delivery for its
 * task has started.
 */
export function registerTaskRoutes(
  app: FastifyInstance,
  tasks: TaskStore,
  boopy: Boopy,
  practice?: PracticeLink,
  grokBot?: GrokBotMoments,
) {
  const shown = (view: TaskView): TaskView & { readonly sentTo?: 'grok-bot' } =>
    grokBot?.started(view.taskId) ? { ...view, sentTo: 'grok-bot' } : view;
  const native = {
    onRequest: async (request: FastifyRequest, reply: FastifyReply) => {
      reply.header('Cache-Control', 'no-store');
      if (request.headers.origin !== undefined)
        throw new BoopyError(403, 'browser_not_allowed', 'Use Boopy for tasks.');
    },
  };
  const small = { ...native, bodyLimit: BODY_CAP };

  app.get('/v1/tasks/:taskId', native, async (request, reply) => {
    const claim = await overrideClaim(request);
    if (claim === 'continuity')
      throw new BoopyError(400, 'continuity_refused', 'Continuity stays local-only.');
    if (claim === 'delivery')
      throw new BoopyError(400, 'delivery_refused', 'Delivery stays not-sent.');
    const taskId = literalTaskId(request);
    const view = taskId === undefined ? undefined : tasks.get(taskId);
    return reply.send(view === undefined ? null : shown(view));
  });

  // One task per session in this version: an existing one is returned and the body's ids unused.
  // A task still waiting for its first result is never served without it.
  app.post('/v1/sessions/:sessionId/task', small, async (request) => {
    const began = performance.now();
    const body = OpenRequest.parse(request.body);
    const sessionId = (request.params as { sessionId: string }).sessionId;
    const facts = boopy.taskTurn(sessionId);
    const existing = tasks.forSession(sessionId);
    if (existing !== undefined && existing.revision > 0) return shown(existing);
    const ids = { eventId: body.eventId, taskId: existing?.taskId ?? body.taskId };
    const plan = standIn(sessionId, ids, facts);
    const planned =
      plan === null ? null : await practised(sessionId, plan, facts.referent?.confidence ?? null);
    const outcome =
      planned === null
        ? undefined
        : tasks.openWithResult(
            planned.open,
            planned.result,
            new Date().toISOString(),
            planned.retrieval,
          );
    if (outcome?.status === 'accepted' && planned !== null) {
      const sending = momentSoon(outcome.task, 0, null, memoryLine(planned, outcome.task));
      // A send still running when the wait ends goes on, and journals its outcome once.
      const wait = Math.min(OPENING_WAIT_MS, OPENING_DEADLINE_MS - (performance.now() - began));
      if (sending !== undefined && wait > 0) await within(sending, wait);
      return shown(outcome.task);
    }
    if (outcome === undefined || existing !== undefined)
      throw new BoopyError(
        409,
        'task_unavailable',
        'This session has no completed turn to open a task from.',
      );
    return settle(outcome);
  });

  // Zetaris calls run one at a time: a pick and a rewrite both touch the practice table.
  let zetaris: Promise<unknown> = Promise.resolve();
  const inTurn = <T>(work: () => Promise<T>): Promise<T> => {
    const next = zetaris.then(work, work);
    zetaris = next.catch(() => {});
    return next;
  };

  // Opens for one session in flight share one pick, so two cannot decide differently.
  const picking = new Map<string, Promise<Planned>>();
  const practised = (
    sessionId: string,
    plan: NonNullable<ReturnType<typeof standIn>>,
    confidence: number | null,
  ) => {
    const running = picking.get(sessionId);
    if (running !== undefined) return running;
    const planned = pickFor(plan, confidence).finally(() => picking.delete(sessionId));
    picking.set(sessionId, planned);
    return planned;
  };

  /**
   * The opening's first result under the person's goal: earlier practice recalled from the
   * journal through H-MEM, then one Zetaris pick, bounded; a result past the bound is never used.
   * Without a goal nothing changes and nothing is journaled.
   */
  const pickFor = async (
    plan: NonNullable<ReturnType<typeof standIn>>,
    confidence: number | null,
  ): Promise<Planned> => {
    const goal = tasks.goal();
    if (goal === null) return plan;
    const annotation = plan.result.components.find((part) => part.type === 'annotation');
    const guess = annotation?.type === 'annotation' ? annotation.text : null;
    const sourceId = plan.open.source.sourceId;
    const records = tasks.practiceRecords();
    const memory =
      guess === null ? { hits: [], recalled: [] } : recallPractice(records, { guess, sourceId });
    const excluded = [
      ...new Set(records.filter((record) => record.excluded).map((record) => record.taskId)),
    ];
    const key = guess === null ? '' : matchKey(guess);
    const request = TermPickRequest.safeParse({
      table: practice?.table ?? 'practice_check',
      targetLanguage: goal.language,
      personLanguage: goal.personLanguage,
      matchKey: key,
      sourceId,
      recalled: memory.recalled.slice(0, 8),
      excluded: excluded.slice(-64),
      rows: practiceRows(records).slice(-500),
    });
    const started = performance.now();
    let pick: PracticePick = { status: 'passed', rows: [] };
    let picked: TermPickResult | null = null;
    let phase: string | null = null;
    let outcome: 'passed' | 'failed' | 'skipped' = 'skipped';
    if (practice !== undefined && guess !== null && request.success && key !== '') {
      // The bound starts when the open asks, so waiting behind a rewrite in progress counts. A pick
      // whose time ran out while it waited never runs.
      const signal = AbortSignal.timeout(practice.timeoutMs);
      try {
        picked = await Promise.race([
          inTurn(() => {
            signal.throwIfAborted();
            return practice.pick(request.data, signal);
          }),
          new Promise<never>((_resolve, reject) =>
            signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
          ),
        ]);
        pick = { status: 'passed', rows: picked.rows };
        outcome = 'passed';
      } catch (failure) {
        phase = signal.aborted
          ? 'timeout'
          : failure instanceof ZetarisPracticeError
            ? failure.phase
            : 'subprocess';
        pick = { status: 'failed', phase };
        outcome = 'failed';
      }
    }
    const decided = practiceResult(plan, {
      language: goal.language,
      personLanguage: goal.personLanguage,
      languageName: languageName(goal.language, goal.personLanguage),
      pick,
      confidence,
    });
    const retrieval = {
      retrievalId: `ret_${plan.open.taskId.slice(4)}`,
      taskId: plan.open.taskId,
      sessionId: plan.open.sessionId,
      queryId: 'term-pick-v1',
      engine: 'zetaris-local',
      status: 'external-unreviewed',
      goalEventId: goal.eventId,
      targetLanguage: goal.language,
      personLanguage: goal.personLanguage,
      guess,
      matchKey: request.success ? key : '',
      sourceId,
      outcome,
      reason: practice === undefined && guess !== null ? 'not-configured' : decided.reason,
      phase,
      elapsedMs: Math.round(performance.now() - started),
      practice: picked?.practice ?? null,
      stageMs: picked?.stageMs ?? null,
      pickMs: picked?.pickMs ?? null,
      rows: picked?.rows ?? [],
      memory: {
        hits: memory.hits.map((hit) => ({ sourceId: hit.sourceId, relevance: hit.relevance })),
        recalled: memory.recalled.slice(0, 8),
        excluded: excluded.length,
      },
      decision: {
        referenceId: decided.referenceId,
        why: decided.why,
        recalledReferenceId: decided.recalledReferenceId,
      },
    };
    // Without a link the goal cannot be served: the task stays Boopy's plain stand-in.
    if (practice === undefined) return { ...plan, retrieval };
    return { open: plan.open, result: decided.result, retrieval };
  };

  // Each moment goes to the person's own Grok Bot in the background. Only the opening waits, at
  // most OPENING_WAIT_MS and never past OPENING_DEADLINE_MS from its request, so its own view can
  // say it was sent; answers never wait. An opening and
  // each answer after it share one momentId; an answer's carries no picture.
  const momentSoon = (
    task: TaskView,
    attempt: number,
    heard: boolean | null,
    memory: string | null,
  ): Promise<void> | undefined => {
    if (grokBot === undefined) return undefined;
    const term = tasks.practice(task.taskId);
    const annotation = task.components.find((part) => part.type === 'annotation');
    return (async () => {
      const { picture, recorded, pointed } = await boopy.momentPicture(task.sessionId);
      await grokBot.send({
        momentId: `mom_${task.taskId.slice(4)}`,
        attempt,
        taskId: task.taskId,
        sessionId: task.sessionId,
        subject: term?.guess ?? (annotation?.type === 'annotation' ? annotation.text : null),
        term:
          term === null
            ? null
            : {
                text: term.term,
                language: term.language,
                languageName: languageName(term.language, term.personLanguage),
              },
        heard,
        memory,
        recorded,
        pointed,
        picture: heard === null ? picture : null,
      });
    })().catch(() => {});
  };

  const stageSoon = (taskId: string, sessionId: string, stageId: string) => {
    if (practice === undefined) return;
    // Each rewrite reads the journal as it is when its turn comes.
    void inTurn(async () => {
      const started = performance.now();
      const signal = AbortSignal.timeout(15000);
      const base = { stageId, taskId, sessionId, table: practice.table };
      try {
        const staged = await practice.stage(practiceRows(tasks.practiceRecords()), signal);
        tasks.recordStage(
          {
            ...base,
            outcome: 'passed',
            phase: null,
            practice: staged.practice,
            stageMs: staged.stageMs,
            elapsedMs: Math.round(performance.now() - started),
          },
          new Date().toISOString(),
        );
      } catch (failure) {
        tasks.recordStage(
          {
            ...base,
            outcome: 'failed',
            phase: signal.aborted
              ? 'timeout'
              : failure instanceof ZetarisPracticeError && failure.phase !== 'integrity'
                ? failure.phase
                : 'subprocess',
            practice: null,
            stageMs: null,
            elapsedMs: Math.round(performance.now() - started),
          },
          new Date().toISOString(),
        );
      }
    }).catch(() => {});
  };

  // A retry names the same event id. It must never transcribe or record a second time, so a
  // recorded answer replays and one still being transcribed is awaited, not repeated.
  const answering = new Map<
    string,
    { readonly key: string; readonly outcome: Promise<TaskOutcome> }
  >();

  const answer = async (input: Answer, wav: Buffer): Promise<TaskOutcome> => {
    const recognizer = boopy.speechRecognizer;
    if (recognizer === null)
      throw new BoopyError(503, 'recognizer_unavailable', 'Speech is not set up on this Mac.');
    const heard = await recognizer.transcribe(wav).catch(() => {
      throw new BoopyError(502, 'speech_failed', 'Could not transcribe this answer. Try again.');
    });
    if (heard.text.trim() === '')
      throw new BoopyError(422, 'no_words', 'No words were heard. Answer again.');
    const text = personLine.safeParse(heard.text);
    if (!text.success)
      throw new BoopyError(
        422,
        'answer_unusable',
        'That answer does not fit one line of 400 characters. Answer again, more briefly.',
      );
    const { audioSha256, ...change } = input;
    const act = {
      ...change,
      action: {
        type: 'voice_reply',
        text: text.data,
        // The recognizer gives no confidence for its words, and unknown is not certain.
        recognitionUncertain: true,
        audioSha256,
        recognizer: recognizer.name,
      },
    };
    const term = tasks.practice(input.taskId);
    if (term === null) return tasks.act(act, new Date().toISOString());
    // What Boopy heard and its correction are recorded with the attempt, all or none.
    let assessed: boolean | null = null;
    const outcome = tasks.answer(act, new Date().toISOString(), (task, attemptEventId) => {
      const heard = assessAnswer(term.term, text.data);
      assessed = heard === 'heard';
      return {
        assessment: {
          assessmentId: `asm_${attemptEventId.slice(4)}`,
          attemptEventId,
          taskId: task.taskId,
          sessionId: task.sessionId,
          retrievalId: term.retrievalId,
          referenceId: term.referenceId,
          language: term.language,
          term: term.term,
          result: heard,
          recognitionUncertain: true,
          method: 'term-in-recognized-text-v1',
        },
        correction: correctionResult(task, {
          attemptEventId,
          heard,
          term: term.term,
          languageName: languageName(term.language, term.personLanguage),
        }),
      };
    });
    if (outcome.status === 'accepted') {
      stageSoon(input.taskId, input.sessionId, `stg_${input.eventId.slice(4)}`);
      if (assessed !== null) momentSoon(outcome.task, outcome.task.attempts.length, assessed, null);
    }
    return outcome;
  };

  app.post('/v1/tasks/:taskId/answers', native, async (request) => {
    const body = AnswerRequest.parse(request.body);
    const taskId = literalTaskId(request);
    if (taskId === undefined) return settle(UNKNOWN);
    const wav = Buffer.from(body.speech.wav, 'base64');
    const input: Answer = {
      eventId: body.eventId,
      taskId,
      sessionId: body.sessionId,
      expectedRevision: body.expectedRevision,
      audioSha256: createHash('sha256').update(wav).digest('hex'),
    };
    const key = JSON.stringify([
      taskId,
      input.sessionId,
      input.expectedRevision,
      input.audioSha256,
    ]);
    const running = answering.get(body.eventId);
    if (running !== undefined)
      return shown(settle(running.key === key ? await running.outcome : CONFLICT));
    const known = tasks.checkAnswer(input);
    if (known !== undefined) return shown(settle(known));
    const outcome = answer(input, wav);
    answering.set(body.eventId, { key, outcome });
    try {
      return shown(settle(await outcome));
    } finally {
      answering.delete(body.eventId);
    }
  });

  app.post('/v1/tasks/:taskId/actions', small, async (request) => {
    const body = ActionRequest.parse(request.body);
    const taskId = literalTaskId(request);
    if (taskId === undefined) return settle(UNKNOWN);
    if (answering.has(body.eventId)) return settle(CONFLICT);
    const outcome = tasks.act({ ...body, taskId }, new Date().toISOString());
    // A subject the person marked wrong leaves the practice record, so the table is rewritten.
    if (
      outcome.status === 'accepted' &&
      body.action.type === 'wrong_subject' &&
      tasks.practiceRecords().some((record) => record.taskId === taskId)
    )
      stageSoon(taskId, body.sessionId, `stg_${body.eventId.slice(4)}`);
    return shown(settle(outcome));
  });
}

/** The line Boopy's memory of earlier practice shaped, when it shaped one. */
function memoryLine(planned: Planned, task: TaskView): string | null {
  const retrieval = planned.retrieval as
    | { readonly decision?: { readonly recalledReferenceId?: string | null } }
    | undefined;
  if (!retrieval?.decision?.recalledReferenceId) return null;
  const dialogue = task.components.find((part) => part.type === 'dialogue');
  return dialogue?.type === 'dialogue' ? dialogue.text : null;
}

const LocalRequest = z.strictObject({
  eventId: EventId,
  taskId: TaskId,
  connectionId: ConnectionId,
  requestId: RequestId,
  nonce: z.string(),
});
const LocalReply = z.strictObject({ content: z.string() });

const REQUEST_REFUSALS = {
  unknown_task: [404, 'No such task.'],
  session_mismatch: [409, 'This task belongs to another session.'],
  unknown_connection: [404, 'No such connection. Name it on the Mac first.'],
  request_exists: [
    409,
    'This task revision already has a request. To ask again, retry or cancel the task to move it to a new revision.',
  ],
  request_unavailable: [409, 'This task has nothing to ask about at this revision.'],
  cancelled: [409, 'This task is closed.'],
  duplicate_conflict: [409, 'These ids were already used for another request.'],
} as const;

const REPLY_REFUSALS = {
  reply_unreadable: [400, 'The file is not one JSON object of at most 16 KiB.'],
  unknown_request: [404, 'The file answers no request Boopy prepared.'],
  reply_invalid: [422, 'The file is not a reply Boopy can show.'],
  nonce_mismatch: [409, 'The file does not answer this request.'],
  source_mismatch: [409, 'The file names another task or source.'],
  duplicate_conflict: [409, 'This request already took another reply.'],
  cancelled: [409, 'This task is closed.'],
  stale_revision: [409, 'This task has moved on since the request.'],
} as const;

/**
 * The person's own steps for a reply from a named connection, on the connector behind its bearer
 * token and the local-only guard, like the local activity routes. Absent from OpenAPI and MCP.
 * Files come back as content and the command-line tool writes them; nothing here is logged.
 */
export function registerLocalTaskRoutes(
  app: FastifyInstance,
  boopy: Boopy,
  tasks: TaskStore,
  localOnly: (request: FastifyRequest) => Promise<void>,
) {
  const options = {
    bodyLimit: BODY_CAP * 2,
    onRequest: [
      localOnly,
      async (_request: FastifyRequest, reply: FastifyReply) => {
        reply
          .header('Cache-Control', 'no-store')
          .header('X-Content-Type-Options', 'nosniff')
          .header('Referrer-Policy', 'no-referrer');
      },
    ],
  };
  app.post('/v1/local-tasks/connections', options, async (request) => {
    const body = Connect.parse(request.body);
    const outcome = tasks.connect(body, new Date().toISOString());
    if (outcome.status === 'rejected')
      throw new BoopyError(409, outcome.code, 'This connection id names another connection.');
    return { connectionId: body.connectionId, label: body.label };
  });
  app.post('/v1/local-tasks/requests', options, async (request) => {
    const body = LocalRequest.parse(request.body);
    const task = tasks.get(body.taskId);
    if (task === undefined) return refuseRequest('unknown_task');
    // The chip's item in Boopy's session carries the model's confidence; unknown stays null.
    const annotation = task.components.find((part) => part.type === 'annotation');
    const subjectId = annotation?.type === 'annotation' ? annotation.evidenceIds[0] : undefined;
    const subject = boopy.view(task.sessionId).items.find((item) => item.id === subjectId);
    const outcome = tasks.prepareRequest(
      { ...body, sessionId: task.sessionId, subjectConfidence: subject?.confidence ?? null },
      new Date().toISOString(),
    );
    if (outcome.status === 'rejected') return refuseRequest(outcome.code, outcome.requestId);
    return outcome;
  });
  app.post('/v1/local-tasks/replies', options, async (request) => {
    const outcome: ReplyOutcome = tasks.matchReply(
      LocalReply.parse(request.body).content,
      new Date().toISOString(),
    );
    if (outcome.status === 'accepted') return outcome.task;
    const [status, message] = REPLY_REFUSALS[outcome.code];
    throw new BoopyError(status, outcome.code, message);
  });
}

function refuseRequest(
  code: Extract<RequestOutcome, { status: 'rejected' }>['code'],
  requestId: string | null = null,
): never {
  const [status, message] = REQUEST_REFUSALS[code];
  // The request the revision already has is named, since its file may not have been kept.
  const named =
    code === 'request_exists' && requestId !== null
      ? message.replace('a request.', `the request ${requestId}.`)
      : message;
  throw new BoopyError(status, code, named);
}

/** An accepted outcome is the view; a refusal keeps the store's code. */
function settle(outcome: TaskOutcome): TaskView {
  if (outcome.status === 'accepted') return outcome.task;
  const [status, message] = REFUSALS[outcome.code];
  throw new BoopyError(status, outcome.code, message);
}

/** Fastify decodes parameters, so the raw path segment must be the task id itself. */
function literalTaskId(request: FastifyRequest): string | undefined {
  const value = (request.params as { taskId?: string }).taskId;
  const raw = request.raw.url?.split('?')[0]?.split('/')[3];
  if (value === undefined || raw !== value || !TaskId.safeParse(value).success) return undefined;
  return value;
}

async function overrideClaim(request: FastifyRequest): Promise<'continuity' | 'delivery' | null> {
  const fromQuery = claimInQuery(request.raw.url) ?? claimInValue(request.query);
  if (fromQuery === 'continuity') return 'continuity';
  const fromBody = await rawBodyClaim(request);
  if (fromBody === 'continuity') return 'continuity';
  if (fromQuery === 'delivery' || fromBody === 'delivery') return 'delivery';
  return null;
}

/**
 * Fastify does not parse a GET body. Read a small one, look for a forbidden claim, and drop it.
 * The bytes are not logged.
 */
async function rawBodyClaim(request: FastifyRequest): Promise<'continuity' | 'delivery' | null> {
  if (request.body !== undefined && request.body !== null) return claimInBody(request.body);
  const text = await rawBodyText(request);
  if (text === undefined) return null;
  const type = request.headers['content-type'] ?? '';
  if (type.includes('application/x-www-form-urlencoded')) return claimInQuery(`?${text}`);
  try {
    return claimInValue(JSON.parse(text) as unknown);
  } catch {
    return claimInQuery(`?${text}`);
  }
}

async function rawBodyText(request: FastifyRequest): Promise<string | undefined> {
  const lengthHeader = request.headers['content-length'];
  const chunked = request.headers['transfer-encoding'] !== undefined;
  if (lengthHeader === undefined && !chunked) return undefined;
  if (lengthHeader !== undefined) {
    const length = Number(lengthHeader);
    if (!Number.isInteger(length) || length < 0 || length > BODY_CAP)
      throw new BoopyError(400, 'invalid_request', 'This read accepts a small JSON body.');
    if (length === 0) return undefined;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request.raw) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > BODY_CAP)
      throw new BoopyError(400, 'invalid_request', 'This read accepts a small JSON body.');
    chunks.push(buffer);
  }
  if (chunks.length === 0) return undefined;
  return Buffer.concat(chunks).toString('utf8');
}

function claimInQuery(url: string | undefined): 'continuity' | 'delivery' | null {
  const query = url?.split('?')[1]?.split('#')[0];
  if (query === undefined || query.length === 0) return null;
  let delivery = false;
  for (const [name, value] of new URLSearchParams(query)) {
    const field = fieldName(name);
    if (field === 'continuity' && value === 'grok-bot') return 'continuity';
    if (field === 'delivery' && value === 'sent') delivery = true;
  }
  return delivery ? 'delivery' : null;
}

function claimInBody(body: unknown): 'continuity' | 'delivery' | null {
  if (typeof body !== 'string') return claimInValue(body);
  try {
    return claimInValue(JSON.parse(body) as unknown);
  } catch {
    return null;
  }
}

function claimInValue(value: unknown, depth = 0): 'continuity' | 'delivery' | null {
  if (depth > 20 || value === null || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    let delivery = false;
    for (const item of value) {
      const claim = claimInValue(item, depth + 1);
      if (claim === 'continuity') return 'continuity';
      if (claim === 'delivery') delivery = true;
    }
    return delivery ? 'delivery' : null;
  }
  const record = value as Record<string, unknown>;
  if (hasExact(record.continuity, 'grok-bot')) return 'continuity';
  let delivery = hasExact(record.delivery, 'sent');
  for (const nested of Object.values(record)) {
    const claim = claimInValue(nested, depth + 1);
    if (claim === 'continuity') return 'continuity';
    if (claim === 'delivery') delivery = true;
  }
  return delivery ? 'delivery' : null;
}

function hasExact(value: unknown, expected: string): boolean {
  if (value === expected) return true;
  if (!Array.isArray(value)) return false;
  for (const item of value) if (item === expected) return true;
  return false;
}

function fieldName(name: string): string {
  const bracket = name.lastIndexOf('[');
  if (bracket !== -1 && name.endsWith(']')) return name.slice(bracket + 1, -1);
  const dot = name.lastIndexOf('.');
  return dot === -1 ? name : name.slice(dot + 1);
}
