/**
 * Interaction protocol v1. A provider may choose content and these component types.
 * Boopy validates the schema. Nothing here is executable, and nothing here is a
 * connection to a person's existing Bot. Delivery stays local-only until a verified
 * provider adapter exists.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { displayText, Sha256 } from '../activity-contract.ts';
import { PickedRow } from '../references/zetaris.ts';

export const TaskId = z.string().regex(/^tsk_[A-Za-z0-9_-]{1,64}$/);
export const EventId = z.string().regex(/^evt_[A-Za-z0-9_-]{1,64}$/);
export const ResultId = z.string().regex(/^res_[A-Za-z0-9_-]{1,64}$/);
export const SessionId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const SourceId = z.string().regex(/^src_[A-Za-z0-9_-]{1,64}$/);
export const EvidenceId = z.string().regex(/^[A-Za-z0-9_.:-]{1,80}$/);
export const MaskId = z.string().regex(/^msk_[A-Za-z0-9_-]{1,64}$/);
const OptionId = z.string().regex(/^opt_[a-z0-9]{1,16}$/);
export const Revision = z.number().int().min(0).max(1_000_000);
export const Intent = z.enum(['continue_saved_task', 'consult_source', 'save_for_later']);
export type Intent = z.infer<typeof Intent>;

/** The person's words, kept after NFC and trimming. Not an assistant display string. */
export const personLine = z.string().transform((value, context) => {
  const text = value.normalize('NFC').trim();
  const length = [...text].length;
  const problem =
    length === 0
      ? 'Must not be empty.'
      : length > 400
        ? 'Use at most 400 characters.'
        : /[\p{Cc}\p{Cs}\u2028\u2029]/u.test(text)
          ? 'Use a single line without control characters.'
          : null;
  if (problem === null) return text;
  context.issues.push({ code: 'custom', message: problem, input: value });
  return z.NEVER;
});

export const SourceRef = z.strictObject({
  sourceId: SourceId,
  sourceRevision: z.number().int().min(1).max(1_000_000),
  sha256: Sha256,
});
export type SourceRef = z.infer<typeof SourceRef>;

export const At = z.iso.datetime();

const Subject = z.strictObject({
  type: z.literal('subject'),
  sourceId: SourceId,
  maskId: MaskId.nullable(),
});
const Annotation = z.strictObject({
  type: z.literal('annotation'),
  text: displayText(80),
  evidenceIds: z.array(EvidenceId).min(1).max(4),
});
const Dialogue = z.strictObject({
  type: z.literal('dialogue'),
  text: displayText(200),
  evidenceIds: z.array(EvidenceId).min(1).max(8),
});
const Choice = z.strictObject({
  type: z.literal('choice'),
  prompt: displayText(160),
  options: z
    .array(z.strictObject({ id: OptionId, label: displayText(60) }))
    .min(1)
    .max(3),
});
const VoiceReply = z.strictObject({
  type: z.literal('voice_reply'),
  prompt: displayText(160),
});
const TaskStep = z.strictObject({
  type: z.literal('task_step'),
  text: displayText(120),
  evidenceIds: z.array(EvidenceId).max(4),
});
const Detail = z.strictObject({
  type: z.literal('detail'),
  text: displayText(500, { multiline: true }),
});
export const Language = z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/);
export const ReferenceSourceId = z.string().regex(/^wikidata:Q[1-9][0-9]{0,11}$/);
/**
 * The outside term for Boopy's guess: one dated Wikidata label read through Zetaris on this Mac,
 * never reviewed. The annotation keeps Boopy's guess; this part holds the source's word for it.
 */
const Term = z.strictObject({
  type: z.literal('term'),
  text: displayText(80),
  language: Language,
  gloss: displayText(80).nullable(),
  sourceId: ReferenceSourceId,
  revision: z.string().regex(/^[0-9]{1,20}$/),
  retrievedAt: At,
  license: z.literal('CC0-1.0'),
  via: z.literal('zetaris-local'),
  reviewed: z.literal(false),
  /** This subject's term was not heard on the person's most recent attempt at it. */
  notHeardLastTime: z.boolean(),
  /**
   * This subject's term was heard on the person's most recent attempt at it. Always set on a new
   * part; absent only on parts journaled before it existed, which read as false.
   */
  heardLastTime: z.boolean().optional(),
});
const AgentPresence = z.strictObject({
  type: z.literal('agent_presence'),
  mode: z.enum(['ambient', 'engaged', 'present']),
});

export const Component = z.discriminatedUnion('type', [
  Subject,
  Annotation,
  Dialogue,
  Choice,
  VoiceReply,
  TaskStep,
  Detail,
  AgentPresence,
  Term,
]);
export type Component = z.infer<typeof Component>;

export const StatusCode = z.enum([
  'checking',
  'cant-read-label',
  'wrong-item',
  'try-again',
  'not-sent',
  'still-checking',
  'continue-later',
]);
export type StatusCode = z.infer<typeof StatusCode>;
export type StatusComponent = { readonly type: 'status'; readonly code: StatusCode };
export type ViewComponent = Component | StatusComponent;

const INTERACTION = new Set(['dialogue', 'choice', 'voice_reply', 'task_step']);

/** Structural rules for one provider component list. Returns the first problem. */
export function componentProblem(
  components: readonly Component[],
  sourceId: string,
  evidenceIds: ReadonlySet<string>,
): string | null {
  const counts = new Map<string, number>();
  let interactive = 0;
  for (const component of components) {
    counts.set(component.type, (counts.get(component.type) ?? 0) + 1);
    if (INTERACTION.has(component.type)) interactive += 1;
    if (component.type === 'subject' && component.sourceId !== sourceId)
      return 'Subject source does not match the task source.';
    if ('evidenceIds' in component && component.evidenceIds.some((id) => !evidenceIds.has(id)))
      return 'Component evidence is not in the result evidence list.';
  }
  for (const count of counts.values()) if (count > 1) return 'Use at most one of each component.';
  if (interactive < 1) return 'Include one dialogue, choice, voice reply, or task step.';
  return null;
}

export const UserAction = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('voice_reply'),
    text: personLine,
    recognitionUncertain: z.boolean(),
    /** Provenance of a spoken answer: the SHA-256 of the audio the Mac received. */
    audioSha256: Sha256.optional(),
    /** Provenance of a spoken answer: the local recognizer that made the text. */
    recognizer: z
      .string()
      .regex(/^[^\p{Cc}]{1,120}$/u)
      .optional(),
  }),
  z.strictObject({ type: z.literal('wrong_subject') }),
  z.strictObject({ type: z.literal('save_for_later') }),
  z.strictObject({ type: z.literal('retry') }),
  z.strictObject({ type: z.literal('cancel') }),
]);
export type UserAction = z.infer<typeof UserAction>;

/** What the person said as a task opened: their words, or exactly nothing for a boop by pointing. */
export const openingWords = z.union([z.literal(''), personLine]);

export const OpenTask = z.strictObject({
  eventId: EventId,
  sessionId: SessionId,
  taskId: TaskId,
  source: SourceRef,
  intent: Intent,
  utterance: openingWords,
});
export type OpenTask = z.infer<typeof OpenTask>;

export const ActInput = z.strictObject({
  eventId: EventId,
  sessionId: SessionId,
  taskId: TaskId,
  expectedRevision: Revision,
  action: UserAction,
});
export type ActInput = z.infer<typeof ActInput>;

export const ProviderResult = z
  .strictObject({
    resultId: ResultId,
    sessionId: SessionId,
    taskId: TaskId,
    baseRevision: Revision,
    source: SourceRef,
    evidenceIds: z.array(EvidenceId).max(8),
    components: z.array(Component).min(1).max(6),
  })
  .superRefine((value, context) => {
    const problem = componentProblem(
      value.components,
      value.source.sourceId,
      new Set(value.evidenceIds),
    );
    if (problem !== null) context.addIssue({ code: 'custom', message: problem });
  });
export type ProviderResult = z.infer<typeof ProviderResult>;

export function payloadHash(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Invalid task payload number.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    // An undefined field is absent, as it is once the journal stores the payload as JSON.
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(',')}}`;
  }
  throw new Error('Invalid task payload value.');
}

export const OpenedData = z.strictObject({
  payloadSha256: Sha256,
  eventId: EventId,
  taskId: TaskId,
  sessionId: SessionId,
  source: SourceRef,
  intent: Intent,
  utterance: openingWords,
  revision: z.literal(0),
  outcome: z.literal('accepted'),
});
export type OpenedData = z.infer<typeof OpenedData>;

export const ActionAcceptedData = z.strictObject({
  payloadSha256: Sha256,
  eventId: EventId,
  taskId: TaskId,
  sessionId: SessionId,
  expectedRevision: Revision,
  revision: Revision,
  action: UserAction,
  outcome: z.literal('accepted'),
});
export type ActionAcceptedData = z.infer<typeof ActionAcceptedData>;

export const ActionRejectedData = z.strictObject({
  payloadSha256: Sha256,
  eventId: EventId,
  taskId: TaskId,
  sessionId: SessionId,
  expectedRevision: Revision,
  revision: Revision,
  action: UserAction,
  code: z.enum(['stale_revision', 'cancelled']),
  outcome: z.literal('rejected'),
});
export type ActionRejectedData = z.infer<typeof ActionRejectedData>;

export const ProviderAcceptedData = z.strictObject({
  payloadSha256: Sha256,
  resultId: ResultId,
  taskId: TaskId,
  sessionId: SessionId,
  baseRevision: Revision,
  revision: Revision,
  source: SourceRef,
  evidenceIds: z.array(EvidenceId).max(8),
  components: z.array(Component).min(1).max(6),
  simulator: z.literal(true),
  outcome: z.literal('accepted'),
});
export type ProviderAcceptedData = z.infer<typeof ProviderAcceptedData>;

export const ProviderRejectedData = z.strictObject({
  payloadSha256: Sha256,
  resultId: ResultId,
  taskId: TaskId,
  sessionId: SessionId,
  baseRevision: Revision,
  revision: Revision,
  source: SourceRef,
  evidenceIds: z.array(EvidenceId).max(8),
  components: z.array(Component).min(1).max(6),
  code: z.enum(['stale_revision', 'cancelled', 'source_mismatch']),
  outcome: z.literal('rejected'),
  simulator: z.literal(true),
});
export type ProviderRejectedData = z.infer<typeof ProviderRejectedData>;

export const ConnectionId = z.string().regex(/^con_[A-Za-z0-9_-]{1,64}$/);
export const RequestId = z.string().regex(/^trq_[A-Za-z0-9_-]{1,64}$/);
const Nonce = z.string().regex(/^[a-f0-9]{32}$/);

/**
 * A connection the person names on the Mac and carries files through, such as a chat with their
 * own assistant. The label is theirs, shown as typed; Boopy never knows who answers through it.
 */
export const Connect = z.strictObject({
  eventId: EventId,
  connectionId: ConnectionId,
  label: displayText(40),
});
export type Connect = z.infer<typeof Connect>;

export const ConnectionCreatedData = z.strictObject({
  payloadSha256: Sha256,
  eventId: EventId,
  connectionId: ConnectionId,
  label: displayText(40),
  channel: z.literal('person-file'),
});
export type ConnectionCreatedData = z.infer<typeof ConnectionCreatedData>;

export const PrepareRequest = z.strictObject({
  eventId: EventId,
  taskId: TaskId,
  sessionId: SessionId,
  connectionId: ConnectionId,
  requestId: RequestId,
  nonce: Nonce,
  /** The model's confidence in the subject's label, from Boopy's session; null when unknown. */
  subjectConfidence: z.number().min(0).max(1).nullable().default(null),
});
export type PrepareRequest = z.infer<typeof PrepareRequest>;

/** The journal keeps the nonce's digest, never the nonce. */
export const RequestPreparedData = z.strictObject({
  payloadSha256: Sha256,
  eventId: EventId,
  requestId: RequestId,
  taskId: TaskId,
  sessionId: SessionId,
  connectionId: ConnectionId,
  revision: Revision,
  evidenceIds: z.array(EvidenceId).min(1).max(4),
  fileSha256: Sha256,
  nonceSha256: Sha256,
});
export type RequestPreparedData = z.infer<typeof RequestPreparedData>;

/**
 * A reply file: Boopy's respondWith, filled in by whoever answered through the connection. Only a
 * line and an answer prompt; the subject and its chip stay Boopy's. Nothing else is accepted.
 */
export const TaskReply = z.strictObject({
  type: z.literal('boopy.task-reply'),
  version: z.literal(1),
  requestId: RequestId,
  taskId: TaskId,
  baseTaskRevision: Revision,
  source: SourceRef,
  nonce: Nonce,
  previousReplyId: z.null(),
  components: z
    .array(z.discriminatedUnion('type', [Dialogue, VoiceReply]))
    .min(1)
    .max(2),
});
export type TaskReply = z.infer<typeof TaskReply>;

export const ReplyMatchedData = z.strictObject({
  payloadSha256: Sha256,
  requestId: RequestId,
  taskId: TaskId,
  sessionId: SessionId,
  connectionId: ConnectionId,
  label: displayText(40),
  fileSha256: Sha256,
  baseRevision: Revision,
  revision: Revision,
  components: z.array(Component).min(1).max(2),
  authorship: z.literal('claimed-by-file'),
  outcome: z.literal('accepted'),
});
export type ReplyMatchedData = z.infer<typeof ReplyMatchedData>;

export const ReplyCode = z.enum([
  'reply_invalid',
  'nonce_mismatch',
  'source_mismatch',
  'cancelled',
  'stale_revision',
  'duplicate_conflict',
]);
export const ReplyRejectedData = z.strictObject({
  payloadSha256: Sha256,
  requestId: RequestId,
  taskId: TaskId,
  sessionId: SessionId,
  fileSha256: Sha256,
  revision: Revision,
  code: ReplyCode,
  outcome: z.literal('rejected'),
});
export type ReplyRejectedData = z.infer<typeof ReplyRejectedData>;

/** What Boopy heard in a spoken answer against the task's term. Never a grade. */
export const Heard = z.enum(['heard', 'not-heard', 'unclear']);
export type Heard = z.infer<typeof Heard>;

/**
 * The person's goal, set on the Mac: practise words in one language, shown around words of their
 * own language. A null language turns practice off. The latest goal holds.
 */
export const SetGoal = z.strictObject({
  eventId: EventId,
  language: Language.nullable(),
  personLanguage: Language,
});
export type SetGoal = z.infer<typeof SetGoal>;
export const GoalSetData = SetGoal.extend({
  payloadSha256: Sha256,
  kind: z.literal('practice-language'),
});
export type GoalSetData = z.infer<typeof GoalSetData>;

export const RetrievalId = z.string().regex(/^ret_[A-Za-z0-9_-]{1,64}$/);
export const RetrievalReason = z.enum([
  'term',
  'no-guess',
  'no-match',
  'ambiguous',
  'not-displayable',
  'unavailable',
  'integrity',
  'not-configured',
]);
export type RetrievalReason = z.infer<typeof RetrievalReason>;
const Ms = z.number().int().min(0).max(600000);
const Staged = z.strictObject({
  tableRows: z.number().int().min(0),
  journalRows: z.number().int().min(0),
  restaged: z.boolean(),
});

/**
 * One term-pick-v1 retrieval when a task opens under a practice goal: what was asked (Boopy's guess
 * as the model proposed it, its match key, the source, the Q-ids memory recalled and how many tasks
 * were left out), what came back (the engine's rows as returned, checked against the import), and
 * what Boopy decided. Rows are a dated snapshot through Zetaris on this Mac, never reviewed.
 */
export const ReferenceRetrievedData = z.strictObject({
  payloadSha256: Sha256,
  retrievalId: RetrievalId,
  taskId: TaskId,
  sessionId: SessionId,
  queryId: z.literal('term-pick-v1'),
  engine: z.literal('zetaris-local'),
  status: z.literal('external-unreviewed'),
  goalEventId: EventId,
  targetLanguage: Language,
  personLanguage: Language,
  guess: displayText(80).nullable(),
  matchKey: z.string().max(80),
  sourceId: SourceId,
  outcome: z.enum(['passed', 'failed', 'skipped']),
  reason: RetrievalReason,
  phase: z
    .enum([
      'input',
      'credentials',
      'subprocess',
      'connect',
      'query',
      'result',
      'integrity',
      'timeout',
    ])
    .nullable(),
  elapsedMs: Ms,
  practice: Staged.nullable(),
  stageMs: Ms.nullable(),
  pickMs: Ms.nullable(),
  rows: z.array(PickedRow).max(9),
  memory: z.strictObject({
    hits: z
      .array(
        z.strictObject({
          sourceId: z.string().min(1).max(200),
          relevance: z.number().min(-2).max(2),
        }),
      )
      .max(8),
    recalled: z.array(z.string().regex(/^Q[1-9][0-9]{0,11}$/)).max(8),
    excluded: z.number().int().min(0),
  }),
  decision: z.strictObject({
    referenceId: z
      .string()
      .regex(/^Q[1-9][0-9]{0,11}$/)
      .nullable(),
    why: z.enum(['new', 'heard-before', 'not-heard-before', 'unclear-before']).nullable(),
    recalledReferenceId: z
      .string()
      .regex(/^Q[1-9][0-9]{0,11}$/)
      .nullable(),
  }),
});
export type ReferenceRetrievedData = z.infer<typeof ReferenceRetrievedData>;
export type ReferenceRetrieved = Omit<ReferenceRetrievedData, 'payloadSha256'>;

/** Boopy's check of one spoken answer against the task's term; the recognizer stays uncertain. */
export const AnswerAssessedData = z.strictObject({
  payloadSha256: Sha256,
  assessmentId: z.string().regex(/^asm_[A-Za-z0-9_-]{1,64}$/),
  attemptEventId: EventId,
  taskId: TaskId,
  sessionId: SessionId,
  retrievalId: RetrievalId,
  referenceId: z.string().regex(/^Q[1-9][0-9]{0,11}$/),
  language: Language,
  term: displayText(80),
  result: Heard,
  recognitionUncertain: z.literal(true),
  method: z.literal('term-in-recognized-text-v1'),
});
export type AnswerAssessedData = z.infer<typeof AnswerAssessedData>;
export type AnswerAssessment = Omit<AnswerAssessedData, 'payloadSha256'>;

/** One rewrite of the practice table in Zetaris from the journal, after an assessed answer. */
export const PracticeStagedData = z.strictObject({
  payloadSha256: Sha256,
  stageId: z.string().regex(/^stg_[A-Za-z0-9_-]{1,64}$/),
  taskId: TaskId,
  sessionId: SessionId,
  table: z.enum(['practice_attempt', 'practice_check']),
  outcome: z.enum(['passed', 'failed']),
  phase: z
    .enum(['input', 'credentials', 'subprocess', 'connect', 'query', 'result', 'timeout'])
    .nullable(),
  practice: Staged.nullable(),
  stageMs: Ms.nullable(),
  elapsedMs: Ms,
});
export type PracticeStagedData = z.infer<typeof PracticeStagedData>;
export type PracticeStaged = Omit<PracticeStagedData, 'payloadSha256'>;

type Envelope<Type extends string, Actor extends 'person' | 'system', Data> = {
  readonly type: Type;
  readonly session: string;
  readonly actor: Actor;
  readonly data: Data;
};

export type TaskEvent =
  // The person opens a task directly; the system opens one from the person's turn.
  | Envelope<'task.opened', 'person' | 'system', OpenedData>
  | Envelope<'task.action-accepted', 'person', ActionAcceptedData>
  | Envelope<'task.action-rejected', 'person', ActionRejectedData>
  | Envelope<'task.provider-accepted', 'system', ProviderAcceptedData>
  | Envelope<'task.provider-rejected', 'system', ProviderRejectedData>
  | Envelope<'connection.created', 'person', ConnectionCreatedData>
  | Envelope<'task.request-prepared', 'person', RequestPreparedData>
  | Envelope<'task.reply-matched', 'person', ReplyMatchedData>
  | Envelope<'task.reply-rejected', 'person', ReplyRejectedData>
  | Envelope<'goal.set', 'person', GoalSetData>
  | Envelope<'task.reference-retrieved', 'system', ReferenceRetrievedData>
  | Envelope<'task.answer-assessed', 'system', AnswerAssessedData>
  | Envelope<'task.practice-staged', 'system', PracticeStagedData>;

export type Attempt = {
  readonly eventId: string;
  readonly text: string;
  readonly recognitionUncertain: boolean;
  readonly kind: 'practice-attempt';
  /** What Boopy heard against the task's term; absent when the task has no term. */
  readonly heard?: Heard;
};

export type TaskView = {
  readonly taskId: string;
  readonly sessionId: string;
  readonly revision: number;
  readonly source: SourceRef;
  readonly intent: Intent;
  readonly utterance: string;
  readonly phase: 'open' | 'cancelled';
  readonly continuity: 'local-only';
  readonly delivery: 'not-sent';
  readonly subjectCorrected: boolean;
  readonly components: readonly ViewComponent[];
  readonly attempts: readonly Attempt[];
  readonly lastRejection: { readonly eventId: string; readonly code: string } | null;
  /** After a matched reply: the person's name for the connection it came through, nothing more. */
  readonly reply?: { readonly connection: string };
};

export type TaskOutcome =
  | { readonly status: 'accepted'; readonly task: TaskView }
  | {
      readonly status: 'rejected';
      readonly code:
        | 'unknown_task'
        | 'session_mismatch'
        | 'task_exists'
        | 'duplicate_conflict'
        | 'stale_revision'
        | 'cancelled'
        | 'source_mismatch'
        | 'answer_not_offered';
      readonly task: TaskView | null;
    };

/** What a reply file the person brought back did to its task. */
export type ReplyOutcome =
  | { readonly status: 'accepted'; readonly task: TaskView }
  | {
      readonly status: 'rejected';
      readonly code: 'reply_unreadable' | 'unknown_request' | z.infer<typeof ReplyCode>;
      readonly task: TaskView | null;
    };

export type RequestOutcome =
  | {
      readonly status: 'accepted';
      readonly requestId: string;
      readonly fileName: string;
      readonly file: string;
      readonly fileSha256: string;
    }
  | {
      readonly status: 'rejected';
      readonly code:
        | 'unknown_task'
        | 'session_mismatch'
        | 'unknown_connection'
        | 'request_exists'
        | 'request_unavailable'
        | 'cancelled'
        | 'duplicate_conflict';
      readonly requestId: string | null;
    };
