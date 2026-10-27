/**
 * The labeled local stand-in for a capture's first completed turn: the task Boopy opens from that
 * turn and the one result it records, projected from Boopy's own reply about the selected subject.
 * It is not the person's assistant, and nothing here is sent anywhere.
 */
import { createHash } from 'node:crypto';
import type { z } from 'zod';
import { displayText, Sha256 } from '../activity-contract.ts';
import type { TaskTurn } from '../boopy.ts';
import type { PickedRow } from '../references/zetaris.ts';
import {
  type Component,
  EvidenceId,
  type Heard,
  OpenTask,
  ProviderResult,
  personLine,
  type RetrievalReason,
  type TaskView,
} from './contract.ts';
import { earlierPracticeLine, practiceWords, SOURCE_LINE } from './practice.ts';

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
 * be one line of at most 400 characters, or none at all for a boop by pointing. A label or reply the display rules refuse is left out,
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
    !(turn.words === '' || unchanged(personLine, turn.words))
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

/** What a term pick gave the stand-in: the engine's rows as checked, or a failure's phase. */
export type PracticePick =
  | { readonly status: 'passed'; readonly rows: readonly PickedRow[] }
  | { readonly status: 'failed'; readonly phase: string };

/**
 * The first result under a practice goal. Boopy's guess stays the annotation. A term shows only
 * from a subject match: exactly one item whose label or alias is the guess, with a label in the
 * target language that the display rules take as it is. Earlier practice on another concept goes
 * only into the detail, never onto the subject. Every other outcome keeps the subject and the guess
 * and says plainly why there is no word, with no answer offered. Without a guess nothing changes.
 */
export function practiceResult(
  plan: { readonly open: OpenTask; readonly result: ProviderResult },
  input: {
    readonly language: string;
    /** The person's own language; a model line in the target language's script is never shown. */
    readonly personLanguage?: string;
    readonly languageName: string;
    readonly pick: PracticePick;
    /** The model's confidence in the subject; null, or under 0.5, is said as unsure. */
    readonly confidence: number | null;
  },
): {
  readonly result: ProviderResult;
  readonly reason: RetrievalReason;
  readonly referenceId: string | null;
  readonly why: PickedRow['why'] | null;
  readonly recalledReferenceId: string | null;
} {
  const { result } = plan;
  const subject = result.components.find((part) => part.type === 'subject');
  const annotation = result.components.find((part) => part.type === 'annotation');
  const line = result.components.find((part) => part.type === 'dialogue');
  const unchangedPlan = (reason: RetrievalReason) => ({
    result,
    reason,
    referenceId: null,
    why: null,
    recalledReferenceId: null,
  });
  if (
    subject?.type === 'subject' &&
    line?.type === 'dialogue' &&
    annotation?.type !== 'annotation'
  ) {
    // Without a guess nothing is looked up, and the model's own words in the target language are
    // not Boopy's to show: only the word list gives those.
    if (!inScriptOf(line.text, input.language, input.personLanguage))
      return unchangedPlan('no-guess');
    const plain = ProviderResult.safeParse({
      ...result,
      components: [
        subject,
        {
          type: 'dialogue',
          text: practiceWords({ language: input.languageName, guess: 'this', term: '' }).noMatch,
          evidenceIds: line.evidenceIds,
        },
      ],
    });
    return plain.success
      ? {
          result: plain.data,
          reason: 'no-guess',
          referenceId: null,
          why: null,
          recalledReferenceId: null,
        }
      : unchangedPlan('no-guess');
  }
  if (annotation?.type !== 'annotation' || subject?.type !== 'subject' || line?.type !== 'dialogue')
    return unchangedPlan('no-guess');
  const guess = annotation.text;
  const subjects =
    input.pick.status === 'passed'
      ? input.pick.rows.filter((row) => row.matched === 'subject')
      : [];
  const match = subjects.length === 1 ? subjects[0] : undefined;
  const reason: RetrievalReason =
    input.pick.status === 'failed'
      ? input.pick.phase === 'integrity'
        ? 'integrity'
        : 'unavailable'
      : subjects.length > 1
        ? 'ambiguous'
        : match?.term == null
          ? 'no-match'
          : unchanged(LABEL, match.term)
            ? 'term'
            : 'not-displayable';
  const words = practiceWords({
    language: input.languageName,
    guess,
    term: match?.term ?? '',
  });
  if (reason !== 'term' || match === undefined || match.term === null) {
    const said = {
      'no-match': words.noMatch,
      ambiguous: words.ambiguous,
      'not-displayable': words.notDisplayable,
      unavailable: words.unavailable,
      integrity: words.integrity,
    }[reason as 'no-match' | 'ambiguous' | 'not-displayable' | 'unavailable' | 'integrity'];
    const plain = ProviderResult.safeParse({
      ...result,
      components: [
        subject,
        annotation,
        { type: 'dialogue', text: said, evidenceIds: line.evidenceIds },
      ],
    });
    return plain.success
      ? { result: plain.data, reason, referenceId: null, why: null, recalledReferenceId: null }
      : unchangedPlan(reason);
  }
  const cited = `wikidata:${match.referenceId}.${input.language}`;
  const earlier =
    input.pick.status === 'passed'
      ? input.pick.rows.find(
          (row) =>
            row.matched === 'recalled' &&
            row.attempts > 0 &&
            row.term !== null &&
            unchanged(LABEL, row.term) &&
            row.gloss !== null,
        )
      : undefined;
  const practised = ProviderResult.safeParse({
    ...result,
    evidenceIds: [...new Set([...result.evidenceIds, cited])],
    components: [
      subject,
      annotation,
      {
        type: 'term',
        text: match.term,
        language: input.language,
        gloss: match.gloss ?? match.matchedText,
        sourceId: match.referenceSourceId,
        revision: match.revisionId,
        retrievedAt: match.retrievedAt,
        license: match.license,
        via: 'zetaris-local',
        reviewed: false,
        notHeardLastTime: match.why === 'not-heard-before',
      },
      {
        type: 'dialogue',
        text:
          match.why === 'not-heard-before'
            ? words.again
            : input.confidence === null || input.confidence < 0.5
              ? words.unsure
              : words.first,
        evidenceIds: [...new Set([...line.evidenceIds, cited])],
      },
      { type: 'voice_reply', prompt: ANSWER_PROMPT },
      {
        type: 'detail',
        text:
          earlier?.term != null && earlier.gloss !== null
            ? `${SOURCE_LINE}\n${earlierPracticeLine(earlier.term, earlier.gloss)}`
            : SOURCE_LINE,
      },
    ],
  });
  if (!practised.success) return unchangedPlan('not-displayable');
  return {
    result: practised.data,
    reason,
    referenceId: match.referenceId,
    why: match.why,
    recalledReferenceId: earlier?.referenceId ?? null,
  };
}

/**
 * Boopy's own reply to one spoken answer on a practice task, as the next stand-in result: the
 * subject, the guess, the term and its detail stay; the line says what Boopy heard and cites the
 * attempt; an answer is offered again only when the line asks. The recognized text is never quoted.
 */
export function correctionResult(
  task: TaskView,
  input: {
    readonly attemptEventId: string;
    readonly heard: Heard;
    readonly term: string;
    readonly languageName: string;
  },
): ProviderResult {
  const words = practiceWords({ language: input.languageName, guess: '', term: input.term });
  const text = { heard: words.heard, 'not-heard': words.notHeard, unclear: words.unclear }[
    input.heard
  ];
  const kept = task.components.filter(
    (part): part is Component =>
      part.type === 'subject' ||
      part.type === 'annotation' ||
      part.type === 'term' ||
      part.type === 'detail',
  );
  const evidence = kept.flatMap((part) => ('evidenceIds' in part ? part.evidenceIds : []));
  const term = kept.find((part) => part.type === 'term');
  const cited = term?.type === 'term' ? [`${term.sourceId}.${term.language}`] : [];
  const digest = createHash('sha256')
    .update(`${task.taskId}:${input.attemptEventId}`)
    .digest('hex');
  // The answer just given is now the most recent attempt at this term.
  const ordered = [
    ...kept
      .filter((part) => part.type !== 'detail')
      .map((part) =>
        part.type === 'term' ? { ...part, notHeardLastTime: input.heard === 'not-heard' } : part,
      ),
    { type: 'dialogue' as const, text, evidenceIds: [input.attemptEventId] },
    ...(asks(text) ? [{ type: 'voice_reply' as const, prompt: ANSWER_PROMPT }] : []),
    ...kept.filter((part) => part.type === 'detail'),
  ];
  return ProviderResult.parse({
    resultId: `res_${digest.slice(0, 32)}`,
    sessionId: task.sessionId,
    taskId: task.taskId,
    baseRevision: task.revision,
    source: task.source,
    evidenceIds: [...new Set([...evidence, ...cited, input.attemptEventId])],
    components: ordered,
  });
}

/** Unicode scripts by a language's usual writing system, from the runtime's own locale data. */
const SCRIPTS: Record<string, readonly string[]> = {
  Kore: ['Hang', 'Hani'],
  Jpan: ['Hira', 'Kana', 'Hani'],
  Hans: ['Hani'],
  Hant: ['Hani'],
};

function scriptOf(language: string): readonly string[] {
  try {
    const script = new Intl.Locale(language).maximize().script;
    return script === undefined ? [] : (SCRIPTS[script] ?? [script]);
  } catch {
    return [];
  }
}

/**
 * Whether a line holds letters of the target language's script. When that script is also the
 * person's own, nothing can be told apart, and the answer is no.
 */
function inScriptOf(text: string, language: string, personLanguage = 'en'): boolean {
  const target = scriptOf(language);
  const own = new Set(scriptOf(personLanguage));
  return target
    .filter((script) => !own.has(script))
    .some((script) => {
      try {
        return new RegExp(`\\p{Script=${script}}`, 'u').test(text);
      } catch {
        return false;
      }
    });
}
