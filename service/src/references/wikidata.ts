/**
 * A fixed, dated snapshot of named Wikidata items for the outside reference table in Zetaris. Each
 * row is one label, alias or description in one language, with the item's revision and modified
 * time and the time Boopy read it. Wikidata item data is CC0. A request names one item id and
 * nothing about the person. The snapshot is not reviewed and is never called live or current.
 */
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { z } from 'zod';

/** The items the import reads: things a desert scene can show, each with a Wikidata item. */
export const REFERENCE_IDS = [
  'Q210988',
  'Q7375',
  'Q71516',
  'Q25391',
  'Q8514',
  'Q170544',
  'Q34679',
  'Q525',
  'Q14080',
  'Q25292',
  'Q43742',
  'Q832778',
  'Q8502',
  'Q527',
] as const;

/** Wikidata's own language codes. A language without a label stays without one. */
export const REFERENCE_LANGUAGES = ['en', 'ko', 'ar', 'ary', 'fr', 'zgh', 'shi', 'kab'] as const;

export const TERM_COLUMNS = [
  'source_id',
  'reference_id',
  'language',
  'kind',
  'text',
  'match_key',
  'revision_id',
  'modified_at',
  'retrieved_at',
  'reference_url',
  'license',
  'status',
] as const;

export type TermRow = Record<(typeof TERM_COLUMNS)[number], string>;
export type LeftOut = Partial<Record<'quote' | 'control' | 'empty' | 'length', number>>;

const MAX_TEXT = 256;
const QUOTE = /["\\]/u;
const CONTROL = /\p{Cc}/u;

/**
 * The one fold Boopy compares labels with: NFC, case folded through upper then lower case, and
 * runs of white space made one space. The import stores it and the service applies it to the
 * model's label, so the engine only compares exact strings.
 */
export function matchKey(text: string): string {
  return text
    .normalize('NFC')
    .toUpperCase()
    .toLowerCase()
    .normalize('NFC')
    .trim()
    .replace(/\s+/gu, ' ');
}

// Wikibase writes an empty map as an empty array.
const map = <T extends z.ZodType>(value: T) =>
  z.preprocess(
    (input) => (Array.isArray(input) && input.length === 0 ? {} : input),
    z.record(z.string(), value),
  );
const Text = z.object({ language: z.string(), value: z.string() });
const Entity = z.object({
  id: z.string(),
  lastrevid: z.number().int().positive(),
  modified: z.iso.datetime(),
  labels: map(Text).default({}),
  aliases: map(z.array(Text)).default({}),
  descriptions: map(Text).default({}),
});
const EntityData = z.object({ entities: z.record(z.string(), Entity) });

/**
 * The rows for one item from its EntityData body. Refuses a body that names another entity (a
 * redirect included), lacks a revision or time, or gives a text in another language than its key.
 * A text the CSV table cannot hold as is (a quote, a backslash, a control character, empty or over
 * 256 characters) is left out and counted, never rewritten.
 */
export function buildTermRows(
  body: unknown,
  referenceId: string,
  retrievedAt: string,
): { readonly rows: TermRow[]; readonly leftOut: LeftOut; readonly revision: number } {
  if (!(REFERENCE_IDS as readonly string[]).includes(referenceId))
    throw new Error('Not an item this import reads.');
  z.iso.datetime().parse(retrievedAt);
  const { entities } = EntityData.parse(body);
  const ids = Object.keys(entities);
  const entity = entities[referenceId];
  if (ids.length !== 1 || entity === undefined || entity.id !== referenceId)
    throw new Error('The body names another entity.');
  const rows: TermRow[] = [];
  const leftOut: LeftOut = {};
  const add = (
    language: string,
    kind: 'label' | 'alias' | 'description',
    input: z.infer<typeof Text>,
  ) => {
    if (input.language !== language) throw new Error('A text is in another language than its key.');
    const text = input.value.normalize('NFC');
    const problem =
      text.trim() === ''
        ? 'empty'
        : [...text].length > MAX_TEXT
          ? 'length'
          : QUOTE.test(text)
            ? 'quote'
            : CONTROL.test(text)
              ? 'control'
              : null;
    if (problem !== null) {
      leftOut[problem] = (leftOut[problem] ?? 0) + 1;
      return;
    }
    const key = kind === 'description' ? '' : matchKey(text);
    if (kind === 'alias' && rows.some((row) => row.language === language && row.match_key === key))
      return;
    rows.push({
      source_id: `wikidata:${referenceId}`,
      reference_id: referenceId,
      language,
      kind,
      text,
      match_key: key,
      revision_id: String(entity.lastrevid),
      modified_at: entity.modified,
      retrieved_at: retrievedAt,
      reference_url: `https://www.wikidata.org/wiki/${referenceId}`,
      license: 'CC0-1.0',
      status: 'external-unreviewed',
    });
  };
  for (const language of REFERENCE_LANGUAGES) {
    const label = entity.labels[language];
    if (label !== undefined) add(language, 'label', label);
    for (const alias of entity.aliases[language] ?? []) add(language, 'alias', alias);
    const description = entity.descriptions[language];
    if (description !== undefined) add(language, 'description', description);
  }
  return { rows, leftOut, revision: entity.lastrevid };
}

/** The table file: a fixed header, every field quoted, one row per line. */
export function termCsv(rows: readonly TermRow[]): string {
  const line = (values: readonly string[]) => values.map((value) => `"${value}"`).join(',');
  return `${[line(TERM_COLUMNS), ...rows.map((row) => line(TERM_COLUMNS.map((column) => row[column])))].join('\n')}\n`;
}

/** What the import prints: counts and revision ids, no label text. */
export function termReceipt(
  items: readonly {
    readonly referenceId: string;
    readonly revision: number;
    readonly rows: readonly TermRow[];
    readonly leftOut: LeftOut;
  }[],
) {
  const count = (values: readonly string[]) =>
    values.reduce<Record<string, number>>((counts, value) => {
      counts[value] = (counts[value] ?? 0) + 1;
      return counts;
    }, {});
  const rows = items.flatMap((item) => item.rows);
  const leftOut: LeftOut = {};
  for (const item of items)
    for (const [reason, n] of Object.entries(item.leftOut) as [keyof LeftOut, number][])
      leftOut[reason] = (leftOut[reason] ?? 0) + n;
  return {
    items: items.length,
    rows: rows.length,
    byLanguage: count(rows.map((row) => row.language)),
    byKind: count(rows.map((row) => row.kind)),
    leftOut,
    revisions: Object.fromEntries(items.map((item) => [item.referenceId, item.revision])),
  };
}

/** Where the import writes the table file and its receipt, outside Zetaris. */
export const TERM_TABLE = 'BOOPY_TERMS.wikidata_term';

/** One row's identity: the SHA-256 of its fields in column order. */
export function termRowSha256(row: TermRow): string {
  return createHash('sha256')
    .update(JSON.stringify(TERM_COLUMNS.map((column) => row[column])))
    .digest('hex');
}

/** The receipt for an import: the file's SHA-256, its row count and each row's SHA-256 in order. */
export function termReceiptFile(rows: readonly TermRow[], csv: string) {
  return {
    version: 1 as const,
    table: TERM_TABLE,
    file: 'wikidata_term.csv',
    fileSha256: createHash('sha256').update(csv).digest('hex'),
    rows: rows.length,
    rowSha256: rows.map(termRowSha256),
  };
}

const Receipt = z.strictObject({
  version: z.literal(1),
  table: z.literal(TERM_TABLE),
  file: z.literal('wikidata_term.csv'),
  fileSha256: z.string().regex(/^[a-f0-9]{64}$/),
  rows: z.number().int().min(1).max(10000),
  rowSha256: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(10000),
});

/**
 * The words Boopy can teach, for the interpreter to use as a label when one names what the person
 * points at: every English label and alias in the snapshot, one per match key, in snapshot order.
 */
export function teachableWords(
  rows: readonly TermRow[],
  kinds: readonly ('label' | 'alias')[] = ['label', 'alias'],
): string[] {
  const seen = new Set<string>();
  const words: string[] = [];
  for (const row of rows) {
    if (row.language !== 'en' || !(kinds as readonly string[]).includes(row.kind)) continue;
    if (row.match_key === '' || seen.has(row.match_key)) continue;
    seen.add(row.match_key);
    words.push(row.text.trim().replace(/\s+/gu, ' '));
  }
  return words;
}

/** The phrase's last word made singular ("ies" to "y", then "es", then "s" dropped), if known. */
function knownSingular(phrase: string, known: ReadonlySet<string>): string | null {
  const match = /^(.*?)(\S+)$/su.exec(phrase);
  if (match === null) return null;
  const [, head = '', word = ''] = match;
  const candidates = [
    /ies$/iu.test(word) ? `${word.slice(0, -3)}${word.slice(-3) === 'IES' ? 'Y' : 'y'}` : null,
    /es$/iu.test(word) ? word.slice(0, -2) : null,
    /s$/iu.test(word) ? word.slice(0, -1) : null,
  ];
  for (const one of candidates)
    if (one !== null && one !== '' && known.has(matchKey(`${head}${one}`))) return `${head}${one}`;
  return null;
}

/**
 * The word Boopy can teach that a model's label names, so "tents", "desert tent" or "camels in a
 * line" find the snapshot's "tent" or "camel". The label as it is or in the singular may match any
 * English label or alias, so "camels" finds the alias "camel". The looser steps match item labels
 * only, never an alias, so "camera mount" never finds the alias "mount" of a mountain: the label
 * without a trailing "in", "with", "of", "on", "at" or "from" phrase, then that phrase's last
 * word, each as it is or in the singular. Any other label stays exactly as the model gave it ("horses" when no "horse" is).
 */
export function teachableLabel(
  label: string,
  known: { readonly words: ReadonlySet<string>; readonly labels: ReadonlySet<string> },
): string {
  const whole = label.trim().replace(/\s+/gu, ' ');
  if (known.words.has(matchKey(whole))) return whole;
  const head = whole.replace(/\s+(?:in|with|of|on|at|from)\s.*$/isu, '');
  const last = head.split(' ').at(-1) ?? '';
  const loose = (phrase: string) =>
    phrase === ''
      ? null
      : known.labels.has(matchKey(phrase))
        ? phrase
        : knownSingular(phrase, known.labels);
  return knownSingular(whole, known.words) ?? loose(head) ?? loose(last) ?? label;
}

/** Reads the table file back. Only the shape termCsv writes is accepted. */
export function parseTermCsv(text: string): TermRow[] {
  const lines = text.split('\n');
  if (lines.pop() !== '' || lines.shift() !== TERM_COLUMNS.map((column) => `"${column}"`).join(','))
    throw new Error('Not a term table file.');
  return lines.map((line) => {
    if (!line.startsWith('"') || !line.endsWith('"')) throw new Error('Not a term table row.');
    const values = line.slice(1, -1).split('","');
    if (values.length !== TERM_COLUMNS.length || values.some((value) => value.includes('"')))
      throw new Error('Not a term table row.');
    return Object.fromEntries(
      TERM_COLUMNS.map((column, index) => [column, values[index]]),
    ) as TermRow;
  });
}

export type TermSnapshot = { readonly rows: readonly TermRow[]; readonly fileSha256: string };

/**
 * The import as Boopy keeps it outside Zetaris: the table file, checked against its receipt byte
 * for byte and row by row. Neither file may be writable by anyone but its owner.
 */
export async function readTermSnapshot(
  csvPath: string,
  receiptPath: string,
): Promise<TermSnapshot> {
  for (const path of [csvPath, receiptPath]) {
    const info = await lstat(path);
    if (!info.isFile() || info.mode & 0o022) throw new Error('The term snapshot is not private.');
  }
  const receipt = Receipt.parse(JSON.parse(await readFile(receiptPath, 'utf8')));
  const csv = await readFile(csvPath, 'utf8');
  const rows = parseTermCsv(csv);
  if (
    createHash('sha256').update(csv).digest('hex') !== receipt.fileSha256 ||
    rows.length !== receipt.rows ||
    receipt.rowSha256.length !== rows.length ||
    rows.some((row, index) => termRowSha256(row) !== receipt.rowSha256[index])
  )
    throw new Error('The term snapshot does not match its receipt.');
  return { rows, fileSha256: receipt.fileSha256 };
}
