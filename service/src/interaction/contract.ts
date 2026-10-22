/**
 * Interaction protocol v1. A provider may choose content and these component types.
 * Boopy validates the schema. Nothing here is executable, and nothing here is a
 * connection to a person's existing assistant. Delivery stays not-sent.
 */
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
