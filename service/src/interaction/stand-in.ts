/**
 * The labeled local stand-in for a capture's first completed turn: the task Boopy opens from that
 * turn and the one result it records, projected from Boopy's own reply about the selected subject.
 * It is not the person's assistant, and nothing here is sent anywhere.
 */
import { createHash } from 'node:crypto';
import type { z } from 'zod';
import { displayText, Sha256 } from '../activity-contract.ts';
import type { TaskTurn } from '../boopy.ts';
import { type Component, EvidenceId, OpenTask, ProviderResult, personLine } from './contract.ts';

const ANSWER_PROMPT = 'Answer.';
const LABEL = displayText(80);
const LINE = displayText(200);
/** Question marks across scripts that the display rules let through. */
const QUESTION = /[?？؟‽⁇⁈﹖︖⸮]$/u;
/** Closing quotes and brackets that may follow a question mark. */
const CLOSING = /[\p{Pe}\p{Pf}"']+$/u;

/**
 * The opening and the first result for a session's first completed visual turn, or null when the
 * session lacks something they need. Boopy's latest reply must answer that turn without a choice
 * card, the selected subject must stand on that turn's view, and the person's words must already
 * be one line of at most 400 characters. A label or reply the display rules refuse is left out,
 * never shortened or rewritten. An answer is offered only under a shown line that asks the person
 * something, so a reply that is left out opens no task. The result id comes from the reply, so a
 * retry names the same result. When the Mac chose the subject from the person's cue, the model
 * never said its reply is about that item, so the line cites Boopy's own reply item instead, and
 * without one no task opens.
 */
export function standIn(
  sessionId: string,
  ids: { readonly eventId: string; readonly taskId: string },
  facts: TaskTurn,
): { readonly open: OpenTask; readonly result: ProviderResult } | null {
  const { turn, dialogue, referent, cueChosen } = facts;
  // A choice card is the reply's own action, so the task would put a second one beside it.
  if (
    turn === null ||
    dialogue === null ||
    dialogue.utteranceId !== turn.utteranceId ||
    dialogue.choice
  )
    return null;
  if (
    referent === null ||
    referent.status === 'rejected' ||
    referent.status === 'ignored' ||
    referent.grounding.observationId !== turn.observationId ||
    !EvidenceId.safeParse(referent.id).success ||
    !Sha256.safeParse(turn.frameSha256).success ||
    !unchanged(personLine, turn.words)
  )
    return null;
  const sourceId = `src_${turn.observationId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64)}`;
  const source = { sourceId, sourceRevision: 1, sha256: turn.frameSha256 };
  const replyId = cueChosen?.replyId;
  if (replyId === null) return null;
  const lineIds = replyId === undefined ? [referent.id] : [replyId];
  const evidenceIds = replyId === undefined ? [referent.id] : [referent.id, replyId];
  const components: Component[] = [{ type: 'subject', sourceId, maskId: null }];
  if (unchanged(LABEL, referent.label))
    components.push({ type: 'annotation', text: referent.label, evidenceIds: [referent.id] });
  if (unchanged(LINE, dialogue.text)) {
    components.push({ type: 'dialogue', text: dialogue.text, evidenceIds: lineIds });
    if (asks(dialogue.text)) components.push({ type: 'voice_reply', prompt: ANSWER_PROMPT });
  }
  const digest = createHash('sha256')
    .update(`${sessionId}:${dialogue.utteranceId}:${dialogue.at}`)
    .digest('hex');
  const open = OpenTask.safeParse({
    eventId: ids.eventId,
    sessionId,
    taskId: ids.taskId,
    source,
    intent: 'consult_source',
    utterance: turn.words,
  });
  const result = ProviderResult.safeParse({
    resultId: `res_${digest.slice(0, 32)}`,
    sessionId,
    taskId: ids.taskId,
    baseRevision: 0,
    source,
    evidenceIds,
    components,
  });
  return open.success && result.success ? { open: open.data, result: result.data } : null;
}

/**
 * Whether Boopy's line asks the person something: it ends with a question mark, before any closing
 * quotes or brackets. The interpreter has no structured field for this; its open questions are
 * separate items the task view does not show.
 */
function asks(line: string): boolean {
  return QUESTION.test(line.replace(CLOSING, ''));
}

/** Whether a value passes a schema exactly as it is, with nothing trimmed or normalized. */
function unchanged(schema: z.ZodType<string>, value: string): boolean {
  const parsed = schema.safeParse(value);
  return parsed.success && parsed.data === value;
}
