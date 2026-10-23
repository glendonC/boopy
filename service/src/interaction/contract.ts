/**
 * Interaction protocol v1. A provider may choose content and these component types.
 * Boopy validates the schema. Nothing here is executable, and nothing here is a
 * connection to a person's existing Bot. Delivery stays local-only until a verified
 * provider adapter exists.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { displayText, Sha256 } from '../activity-contract.ts';

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

export const OpenTask = z.strictObject({
  eventId: EventId,
  sessionId: SessionId,
  taskId: TaskId,
  source: SourceRef,
  intent: Intent,
  utterance: personLine,
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
  utterance: personLine,
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
  | Envelope<'task.provider-rejected', 'system', ProviderRejectedData>;

export type Attempt = {
  readonly eventId: string;
  readonly text: string;
  readonly recognitionUncertain: boolean;
  readonly kind: 'practice-attempt';
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
