/**
 * Interaction protocol v1. A provider may choose content and these component types.
 * Boopy validates the schema. Nothing here is executable, and nothing here is a
 * connection to a person's existing assistant. Delivery stays not-sent.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';

export const TaskId = z.string().regex(/^tsk_[A-Za-z0-9_-]{1,64}$/);
export const EventId = z.string().regex(/^evt_[A-Za-z0-9_-]{1,64}$/);
export const SessionId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const SourceId = z.string().regex(/^src_[A-Za-z0-9_-]{1,64}$/);
export const EvidenceId = z.string().regex(/^[A-Za-z0-9_.:-]{1,80}$/);
const MaskId = z.string().regex(/^msk_[A-Za-z0-9_-]{1,64}$/);
const Sha256 = z.string().regex(/^[a-f0-9]{64}$/, 'Use a lowercase SHA-256 hex digest.');

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

/** An assistant line: NFC, trimmed, one line, and bounded. */
function assistantLine(max: number) {
  return z.string().transform((value, context) => {
    const text = value.normalize('NFC').trim();
    const length = [...text].length;
    const problem =
      length === 0
        ? 'Must not be empty.'
        : length > max
          ? `Use at most ${max} characters.`
          : /[\p{Cc}\p{Cs}\u2028\u2029]/u.test(text)
            ? 'Use a single line without control characters.'
            : null;
    if (problem === null) return text;
    context.issues.push({ code: 'custom', message: problem, input: value });
    return z.NEVER;
  });
}

export const SourceRef = z.strictObject({
  sourceId: SourceId,
  sourceRevision: z.number().int().min(1).max(1_000_000),
  sha256: Sha256,
});
export type SourceRef = z.infer<typeof SourceRef>;

export const Intent = z.enum(['continue_saved_task', 'consult_source', 'save_for_later']);
export type Intent = z.infer<typeof Intent>;

const Subject = z.strictObject({
  type: z.literal('subject'),
  sourceId: SourceId,
  maskId: MaskId.nullable(),
});
const Annotation = z.strictObject({
  type: z.literal('annotation'),
  text: assistantLine(80),
  evidenceIds: z.array(EvidenceId).min(1).max(4),
});
const Dialogue = z.strictObject({
  type: z.literal('dialogue'),
  text: assistantLine(200),
  evidenceIds: z.array(EvidenceId).min(1).max(8),
});
const VoiceReply = z.strictObject({
  type: z.literal('voice_reply'),
  prompt: assistantLine(160),
});

/** What the assistant proposes. This is not a person's action. */
export const Component = z.discriminatedUnion('type', [Subject, Annotation, Dialogue, VoiceReply]);
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

/** What the person does. A proposal does not parse as one of these. */
export const UserAction = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('voice_reply'),
    text: personLine,
    recognitionUncertain: z.boolean(),
  }),
  z.strictObject({ type: z.literal('wrong_subject') }),
  z.strictObject({ type: z.literal('save_for_later') }),
  z.strictObject({ type: z.literal('retry') }),
  z.strictObject({ type: z.literal('cancel') }),
]);
export type UserAction = z.infer<typeof UserAction>;

export const Revision = z.number().int().min(0).max(1_000_000);
export const At = z.iso.datetime();

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
    return `{${Object.keys(record)
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

type Envelope<Type extends string, Actor extends 'person' | 'system', Data> = {
  readonly type: Type;
  readonly session: string;
  readonly actor: Actor;
  readonly data: Data;
};

export type TaskEvent =
  | Envelope<'task.opened', 'person', OpenedData>
  | Envelope<'task.action-accepted', 'person', ActionAcceptedData>
  | Envelope<'task.action-rejected', 'person', ActionRejectedData>;

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
        | 'cancelled';
      readonly task: TaskView | null;
    };

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
