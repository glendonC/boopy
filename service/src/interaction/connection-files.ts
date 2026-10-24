/**
 * The files a person carries between Boopy and a connection they named (docs/protocol.md, "A reply
 * from a named connection"). Rendering is deterministic: fixed key order, two-space JSON and a
 * final newline. A request carries ids and a digest, never the picture, a path or a secret, and
 * says that Boopy did not send it.
 */
import { readContainer, sha256 } from '../activity-contract.ts';
import type { SourceRef } from './contract.ts';

export const MAX_CONNECTION_FILE_BYTES = 16 * 1024;

const NOTE =
  'The person exported this file from Boopy and chose to share it. Boopy did not send it.';

const INSTRUCTIONS = [
  'Return exactly one .json file. Its whole content is respondWith with the dialogue text filled in.',
  'Copy requestId, taskId, baseTaskRevision, source, nonce, previousReplyId and evidenceIds exactly, character for character.',
  'components holds one dialogue: one line of at most 200 characters that answers what the person said about the subject. Only when that line asks the person something, add {"type": "voice_reply", "prompt": "Answer."} after it.',
  'Boopy did not share the picture. Do not describe what you cannot see, and do not invent places, names, dates or events; ask instead.',
  'Use only Latin letters or Hangul, with no markup, links, emoji or control characters. Add no other field.',
];

export interface RequestFacts {
  readonly requestId: string;
  readonly taskId: string;
  readonly revision: number;
  readonly source: SourceRef;
  readonly nonce: string;
  readonly utterance: string;
  /** The subject's label as the chip shows it: the model's proposal. */
  readonly subject: string;
  /** The model's confidence in that label, or null when it is unknown. */
  readonly subjectConfidence: number | null;
  /** Boopy's own line, when the task shows one. */
  readonly boopyLine: string | null;
  readonly answers: readonly { readonly text: string; readonly recognitionUncertain: boolean }[];
  readonly evidenceIds: readonly string[];
}

export function renderTaskRequest(facts: RequestFacts): {
  fileName: string;
  file: string;
  fileSha256: string;
} {
  const value = {
    type: 'boopy.task-request',
    version: 1,
    note: NOTE,
    task: {
      personSaid: facts.utterance,
      subject: {
        label: facts.subject,
        origin: 'model',
        status: 'proposed',
        confidence: facts.subjectConfidence,
      },
      boopyLine:
        facts.boopyLine === null
          ? null
          : { text: facts.boopyLine, origin: 'boopy-local', status: 'proposed' },
      answers: facts.answers.map(({ text, recognitionUncertain }) => ({
        text,
        recognitionUncertain,
      })),
    },
    instructions: INSTRUCTIONS,
    respondWith: {
      type: 'boopy.task-reply',
      version: 1,
      requestId: facts.requestId,
      taskId: facts.taskId,
      baseTaskRevision: facts.revision,
      source: {
        sourceId: facts.source.sourceId,
        sourceRevision: facts.source.sourceRevision,
        sha256: facts.source.sha256,
      },
      nonce: facts.nonce,
      previousReplyId: null,
      components: [{ type: 'dialogue', text: '', evidenceIds: [...facts.evidenceIds] }],
    },
  };
  const file = `${JSON.stringify(value, null, 2)}\n`;
  return { fileName: `boopy-request-${facts.requestId}.json`, file, fileSha256: sha256(file) };
}

/**
 * A reply file's one JSON object, or its one fenced json block, with the digest of the file as
 * received; null when it is larger than 16 KiB or holds anything else.
 */
export function readTaskReply(
  content: string,
): { value: Record<string, unknown>; fileSha256: string } | null {
  if (Buffer.byteLength(content, 'utf8') > MAX_CONNECTION_FILE_BYTES) return null;
  const found = readContainer(content);
  return found === null ? null : { value: found.value, fileSha256: sha256(content) };
}
