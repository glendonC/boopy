/**
 * The reasoning trace of a session, read from the journal: what Boopy observed, the evidence it
 * proposed, what it retrieved (H-MEM over the journal's practice, one Zetaris query on this Mac),
 * what it decided, what it showed, each moment sent to the person's own Grok Bot, and what changed
 * after an answer. It prints ids, digests'
 * first characters, Boopy's guess, the outside rows and Boopy's own lines. It never prints the
 * person's words, a transcript, OCR text, a file name or path, a frame or audio; a line of Boopy's
 * that contains the person's words is withheld.
 *
 *   node src/cli/trace.ts [--journal <journal.sqlite>] [<sessionId>]
 *
 * Without a session id it prints every session that has a practice retrieval, oldest first.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';

export type TraceRow = {
  readonly type: string;
  readonly session: string;
  readonly actor: string;
  readonly at: string;
  readonly id: string;
  readonly data: unknown;
};

type Data = Record<string, unknown>;
const record = (value: unknown): Data =>
  value !== null && typeof value === 'object' ? (value as Data) : {};
const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const short = (digest: unknown) => (typeof digest === 'string' ? `${digest.slice(0, 8)}…` : 'none');

export function traceLines(rows: readonly TraceRow[], sessionId: string): string[] {
  const events = rows.filter((row) => row.session === sessionId);
  if (events.length === 0) return ['No events for this session.'];
  // The words Boopy itself showed: its guess and the outside terms. A person who says only those
  // has said nothing private, so they are taken out before Boopy's lines are compared.
  const shownWords = events.flatMap((row) => {
    const data = record(row.data);
    if (row.type === 'task.reference-retrieved')
      return [
        text(data.guess),
        ...list(data.rows).flatMap((entry) => {
          const picked = record(entry);
          return [text(picked.term), text(picked.gloss), text(picked.matchedText)];
        }),
      ];
    if (row.type === 'task.answer-assessed') return [text(data.term)];
    return [];
  });
  const known = [...new Set(shownWords.filter((entry): entry is string => entry !== null))].sort(
    (a, b) => b.length - a.length,
  );
  // The person's own words in this session: a line that contains any of them is withheld.
  const words = events.flatMap((row) => {
    const data = record(row.data);
    const said = row.type === 'utterance.heard' ? text(data.text) : null;
    const answered = row.type === 'task.action-accepted' ? text(record(data.action).text) : null;
    return [said, answered]
      .filter((entry): entry is string => entry !== null)
      .flatMap((entry) =>
        known.reduce((rest, word) => rest.split(word).join('\n'), entry).split('\n'),
      )
      .map((part) => part.trim())
      .filter((part) => /[\p{L}\p{N}]{2,}/u.test(part));
  });
  const shown = (line: unknown) => {
    const value = text(line);
    if (value === null) return 'none';
    return words.some((entry) => value.includes(entry))
      ? '(withheld: it contains the person’s words)'
      : `"${value}"`;
  };
  // A task whose moment started a run on the person's own Bot was sent; its send lines say where it
  // went, so its act lines do not claim it stayed local. Failed sends reached nothing.
  const linked = new Set(
    events
      .filter((row) => row.type === 'grokbot.delivery.started')
      .map((row) => text(record(row.data).taskId)),
  );
  const lines = [`Boopy trace for session ${sessionId}, from the journal on this Mac`];
  for (const row of events) {
    const data = record(row.data);
    if (row.type === 'observation.recorded') {
      const recorded = record(data.recorded);
      lines.push(
        `observe   ${text(data.observationId)} frame ${short(data.frameSha256)} ${
          text(recorded.recordingId) === null
            ? `(${text(data.source) ?? 'source unknown'})`
            : `(recorded footage ${text(recorded.recordingId)}, frame ${text(recorded.frameId)})`
        }`,
      );
    } else if (row.type === 'interpretation.proposed') {
      const items = list(data.items).map(record);
      const referent = items.find((item) => item.id === data.referentId);
      const confidence = typeof referent?.confidence === 'number' ? referent.confidence : null;
      lines.push(
        `evidence  Boopy's guess ${referent === undefined ? 'none' : `"${text(referent.label)}"`}, proposed by ${text(data.provider)}/${text(data.model)} in ${data.latencyMs} ms, confidence ${confidence ?? 'unknown'}, item ${text(data.referentId) ?? 'none'}`,
      );
    } else if (row.type === 'task.opened') {
      lines.push(
        `observe   task ${text(data.taskId)} opened on ${text(record(data.source).sourceId)}`,
      );
    } else if (row.type === 'task.reference-retrieved') {
      const memory = record(data.memory);
      const hits = list(memory.hits).map(record);
      lines.push(
        `retrieve  H-MEM over the journal's practice: ${hits.length} hit(s)${hits
          .map((hit) => ` ${text(hit.sourceId)} ${Number(hit.relevance).toFixed(2)}`)
          .join(
            ',',
          )}; recalled ${list(memory.recalled).join(', ') || 'none'}; ${memory.excluded} task(s) left out`,
      );
      const staged = record(data.practice);
      lines.push(
        `retrieve  Zetaris ${text(data.queryId)} on this Mac for "${text(data.guess)}" in ${text(data.targetLanguage)}: ${text(data.outcome)}${data.phase ? ` (${text(data.phase)})` : ''} in ${data.elapsedMs} ms${
          data.pickMs === null || data.pickMs === undefined
            ? ''
            : `; stage ${data.stageMs} ms, pick ${data.pickMs} ms; practice table ${staged.tableRows} rows, journal ${staged.journalRows}, ${staged.restaged ? 'rewritten' : 'unchanged'}`
        }`,
      );
      for (const entry of list(data.rows).map(record))
        lines.push(
          `retrieve    ${text(entry.referenceId)} ${text(entry.matched)} ${text(entry.term) ?? 'no term'} (${text(data.targetLanguage)}), gloss ${text(entry.gloss) ?? text(entry.matchedText) ?? 'none'}; Wikidata revision ${text(entry.revisionId)}, read ${text(entry.retrievedAt)}, ${text(entry.license)}, ${text(entry.status)}; practice ${entry.attempts} attempt(s), ${entry.notHeard} not heard, last ${text(entry.lastResult) ?? 'none'}: ${text(entry.why)}`,
        );
      const decision = record(data.decision);
      lines.push(
        `decide    ${text(data.reason)}${
          decision.referenceId
            ? `: ${text(decision.referenceId)} because ${text(decision.why)}`
            : ''
        }${decision.recalledReferenceId ? `; earlier practice ${text(decision.recalledReferenceId)} in the detail` : ''}`,
      );
    } else if (row.type === 'task.provider-accepted') {
      const parts = list(data.components).map(record);
      const line = parts.find((part) => part.type === 'dialogue');
      const term = parts.find((part) => part.type === 'term');
      lines.push(
        `act       revision ${data.revision}, Boopy's own stand-in${linked.has(text(data.taskId)) ? '' : ', not sent to your AI'}: ${shown(line?.text)}${
          term === undefined
            ? ''
            : `; term ${text(term.text)} (${text(term.language)}) from ${text(term.sourceId)}`
        }`,
      );
    } else if (row.type === 'task.action-accepted') {
      const action = record(data.action);
      lines.push(
        action.type === 'voice_reply'
          ? `update    answer ${row.id}: audio ${short(action.audioSha256)}, recognizer ${text(action.recognizer) ?? 'unknown'}, recognition uncertain; the words are not printed`
          : `update    the person chose ${text(action.type)}${action.type === 'wrong_subject' ? ': its practice leaves later picks' : ''}`,
      );
    } else if (row.type === 'task.answer-assessed') {
      lines.push(
        `update    Boopy heard: ${text(data.result)} against ${text(data.term)} (${text(data.method)}, recognition uncertain)`,
      );
    } else if (row.type === 'grokbot.delivery.started' || row.type === 'grokbot.delivery.failed') {
      // Only the outcome and the Bot's run id: the journal never holds the webhook URL or key.
      const runUuid = text(data.runUuid);
      lines.push(
        `send      moment to your Grok Bot (attempt ${data.attempt}): ${
          row.type === 'grokbot.delivery.started'
            ? `run started, ${runUuid === null ? 'no run id' : `run ${short(runUuid)}`}`
            : typeof data.status === 'number'
              ? `failed, HTTP ${data.status}`
              : 'failed, no answer'
        }`,
      );
    } else if (row.type === 'task.practice-staged') {
      const staged = record(data.practice);
      lines.push(
        `update    practice table in Zetaris rewritten from the journal: ${text(data.outcome)}${
          data.phase ? ` (${text(data.phase)})` : ''
        }${data.practice ? `, ${staged.journalRows} row(s)` : ''} in ${data.elapsedMs} ms`,
      );
    }
  }
  return lines;
}

function rowsOf(path: string): TraceRow[] {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db
      .prepare('SELECT id, type, session, actor, at, data FROM events ORDER BY seq')
      .all()
      .map((row) => ({
        id: String(row.id),
        type: String(row.type),
        session: String(row.session),
        actor: String(row.actor),
        at: String(row.at),
        data: JSON.parse(String(row.data)) as unknown,
      }));
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { journal: { type: 'string' } },
  });
  const path =
    values.journal ??
    join(process.env.BOOPY_DATA_DIR ?? join(homedir(), '.boopy'), 'journal.sqlite');
  const rows = rowsOf(path);
  const sessions =
    positionals.length > 0
      ? positionals
      : [
          ...new Set(
            rows.filter((row) => row.type === 'task.reference-retrieved').map((row) => row.session),
          ),
        ];
  if (sessions.length === 0) console.log('No session with a practice retrieval in this journal.');
  for (const session of sessions) console.log(`${traceLines(rows, session).join('\n')}\n`);
}
