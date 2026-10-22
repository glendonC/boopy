/**
 * The request and submission files Boopy writes (docs/activity-contract.md). Rendering is
 * deterministic: fixed key order, two-space JSON and a final newline, so the same state always
 * gives the same bytes. Files carry no filesystem path, token or secret, and say that Boopy did
 * not send them.
 */
import {
  type ActivityBody,
  arrangeOf,
  type Derived,
  type SourceEntry,
  sha256,
} from './activity-contract.ts';

export type RenderedFile = { fileName: string; file: string; fileSha256: string };

const REQUEST_NOTE =
  'The person exported this file from Boopy and chose to share it. Boopy did not send it.';
const SUBMISSION_NOTE =
  'The person exported this submission from Boopy and chose to share it. Boopy did not send it.';

/** The activity rules, shared by the request and by a reply's optional next activity. */
const ACTIVITY_RULES = [
  'activity has title (up to 60 characters), purpose (up to 200), instruction (a text item: text up to 200, gloss up to 240), components (one or two, at most one of each type) and hints (zero to three text items: text up to 200, gloss up to 240).',
  'A text item is {"text": ..., "language": a tag such as "en" or "ko", "gloss": an optional translation into the person\'s language}.',
  'Component arrange: {"type": "arrange", "axis": ..., "tokens": [...], "target": ...}. Tokens use keys a, b, c and d in that order, each {"key": ..., "label": a text item (text up to 24, gloss up to 40), "sourceId": ...}. Each token sits on its own lane and only its position from left to right carries meaning.',
  'Axis viewer-left-right: {"kind": "viewer-left-right"} with exactly two tokens and an optional target {"subject": "a", "relation": "left-of" or "right-of", "object": "b"}, always from the person\'s own view facing the tray.',
  'Axis scale: {"kind": "scale", "low": up to 24 characters, "high": up to 24 characters} with two to four tokens and no target. Boopy reports only their order.',
  'Axis number: {"kind": "number", "min": ..., "max": ..., "step": ..., "unit": optional, up to 12 characters} with one to four tokens and no target. min and max lie between -1000000000 and 1000000000, step is at least 0.000001, each has at most 6 decimals, and (max - min) / step is a whole number of at most 1000. Boopy reports each snapped value.',
  'Component sequence: {"type": "sequence", "joiner": "space" or "list", "language": a tag, "tiles": three to eight {"key": ..., "text": ...}} with keys t1, t2 and so on in order and unique texts. With "space" each tile is one word without spaces (up to 24 characters); with "list" each tile is a step (up to 48 characters). Boopy never checks the order the person builds.',
  'Use only the components, fields and limits above. A file cannot carry links, code, assets, layout or actions.',
  'Treat an arrangement as a practice construction, not an event or an observation.',
  "Do not invent the person's level, feelings, activities or dates.",
  "When the goal is practice in a language (for example Korean), write token labels and tile texts in that language and put the translation into the person's language in each gloss, not the other way round.",
  'When the goal is practice in a language, include a sequence component in which the person builds the sentence they should say from one-word tiles (joiner "space"), with every word it needs and one or two plausible extra words. Boopy shows the tiles in its own order.',
  'For language practice, make each space tile one spaced word, and never put the full answer anywhere in the file.',
  'Order hints from gentle to specific.',
  'Give hints that help with this activity only.',
  'Use only Latin letters or Hangul, with no markup, links, emoji or control characters.',
];

const REQUEST_INSTRUCTIONS = [
  'Return exactly one downloadable .json file. Its whole content is one JSON object shaped like respondWith, plus "author" (optional, up to 60 characters), "fallbackText" (required, up to 800 characters, may span lines) and "activity".',
  'Copy respondWith.binding exactly, character for character.',
  ...ACTIVITY_RULES,
  'Reference only source IDs listed in sources, or null.',
  "background is the person's own note; when background is null, do not assume a level or any other background.",
  'Write fallbackText as a plain-text version of the same activity.',
];

const SUBMISSION_INSTRUCTIONS = [
  'Return exactly one downloadable .json file. Its whole content is one JSON object shaped like respondWith, plus "author" (optional, up to 60 characters), "reply" and "next".',
  'Copy respondWith.binding and respondWith.echo exactly. The echo shows that the reply was made from this exact submission.',
  'reply is {"summary": a text item (text up to 300, gloss up to 300), "points": one to four {"about": "overall", "arrange", "sequence" or "hints", "text": up to 300, "language": a tag, "gloss": optional, up to 300}}.',
  'Base the reply on what the person actually did in submission. Boopy checked only what boopyChecked shows and did not judge whether any answer is correct.',
  'submission.hintsRevealed is cumulative: it lists every hint revealed in this activity so far, including hints opened before an earlier submission. hintsRevealedSincePrevious lists only the hints opened since the previous submission, so carried-over hints are not opened again.',
  "Treat the arrangement as a practice construction and the sequence as the person's attempt, not as statements about their life.",
  'next is null, or {"fallbackText": a plain-text version of the next activity, up to 800 characters, "activity": a new activity}. A next activity follows the rules below and may reference only source IDs from the original request file, or null.',
  'A next activity must differ from this activity and target one specific thing this submission shows, for example a word order or a missing word in the sequence, or one arrangement choice. Never repeat the same activity unchanged.',
  ...ACTIVITY_RULES,
];

function rendered(fileName: string, value: unknown): RenderedFile {
  const file = `${JSON.stringify(value, null, 2)}\n`;
  return { fileName, file, fileSha256: sha256(file) };
}

/** Section 1: the person's goal, the allowed sources and the exact prepared packet. */
export function renderRequestFile(input: {
  requestId: string;
  exportedAt: string;
  goal: string;
  personLanguage: string;
  background: string | null;
  sources: readonly SourceEntry[];
  packageId: string;
  packetSha256: string;
  packet: string;
  delivery?: 'not-sent' | 'not-sent-by-boopy' | 'sent-by-boopy-to-local-model';
}): RenderedFile {
  return rendered(`boopy-activity-request-${input.requestId}.json`, {
    type: 'boopy.activity-request',
    version: 1,
    requestId: input.requestId,
    exportedAt: input.exportedAt,
    delivery:
      input.delivery === 'sent-by-boopy-to-local-model' ? input.delivery : 'not-sent-by-boopy',
    note:
      input.delivery === 'sent-by-boopy-to-local-model'
        ? 'Boopy sent this request to the local model on this Mac.'
        : REQUEST_NOTE,
    goal: input.goal,
    personLanguage: input.personLanguage,
    background: input.background,
    instructions: REQUEST_INSTRUCTIONS,
    respondWith: {
      type: 'boopy.activity',
      version: 1,
      binding: {
        requestId: input.requestId,
        packageId: input.packageId,
        packetSha256: input.packetSha256,
      },
    },
    sources: input.sources.map((source) => ({
      sourceId: source.sourceId,
      label: source.label,
      gloss: source.gloss,
      verification: source.verification,
    })),
    context: {
      packageId: input.packageId,
      packetSha256: input.packetSha256,
      packet: input.packet,
    },
  });
}

/** Section 6: the exact validated activity and what the person did, frozen at submission. */
export function renderSubmissionFile(input: {
  submissionId: string;
  activityId: string;
  requestId: string;
  exportedAt: string;
  claimedAuthor: string | null;
  authorship?: 'claimed-by-file' | 'called-by-boopy';
  delivery?: 'not-sent' | 'not-sent-by-boopy' | 'sent-by-boopy-to-local-model';
  artifactSha256: string;
  activity: ActivityBody;
  submission: {
    number: number;
    submittedAt: string;
    revision: number;
    positions: Readonly<Record<string, number | null>> | null;
    derived: Derived | null;
    chosen: readonly string[] | null;
    text: string | null;
    hintsRevealed: readonly number[];
    hintsRevealedSincePrevious: readonly number[];
    digest: string;
  };
}): RenderedFile {
  const { activity, submission } = input;
  const target = arrangeOf(activity)?.target ?? null;
  const derived = submission.derived;
  return rendered(`boopy-activity-submission-${input.submissionId}.json`, {
    type: 'boopy.activity-submission',
    version: 1,
    submissionId: input.submissionId,
    activityId: input.activityId,
    requestId: input.requestId,
    exportedAt: input.exportedAt,
    delivery:
      input.delivery === 'sent-by-boopy-to-local-model' ? input.delivery : 'not-sent-by-boopy',
    note:
      input.delivery === 'sent-by-boopy-to-local-model'
        ? 'Boopy sent this submission to the local model on this Mac.'
        : SUBMISSION_NOTE,
    activity: {
      claimedAuthor: input.claimedAuthor,
      authorship: input.authorship ?? 'claimed-by-file',
      artifactSha256: input.artifactSha256,
      body: activity,
    },
    submission: {
      number: submission.number,
      submittedAt: submission.submittedAt,
      revision: submission.revision,
      arrange:
        submission.positions && derived
          ? {
              positions: submission.positions,
              relation: derived.relation,
              matchesTarget: derived.matchesTarget,
              order: derived.order,
              ties: derived.ties,
              values: derived.values,
            }
          : null,
      sequence:
        submission.chosen && submission.text !== null
          ? { chosen: submission.chosen, text: submission.text }
          : null,
      hintsRevealed: submission.hintsRevealed.map((index) => {
        const hint = activity.hints[index];
        return {
          index,
          text: hint?.text ?? '',
          language: hint?.language ?? '',
          gloss: hint?.gloss ?? null,
        };
      }),
      hintsRevealedSincePrevious: [...submission.hintsRevealedSincePrevious],
    },
    // Boopy checks at most the arrangement relation against a requested target.
    boopyChecked: {
      arrangementRelation:
        target && derived
          ? {
              subject: target.subject,
              object: target.object,
              requested: target.relation,
              arranged: derived.relation,
              matches: derived.matchesTarget === true,
            }
          : null,
    },
    digest: submission.digest,
    instructions: SUBMISSION_INSTRUCTIONS,
    respondWith: {
      type: 'boopy.activity-reply',
      version: 1,
      binding: { submissionId: input.submissionId, activityId: input.activityId },
      echo: submission.digest,
    },
  });
}
