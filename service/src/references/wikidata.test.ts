import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildTermRows,
  matchKey,
  parseTermCsv,
  REFERENCE_IDS,
  REFERENCE_LANGUAGES,
  readTermSnapshot,
  TERM_COLUMNS,
  termCsv,
  termReceipt,
  termReceiptFile,
} from './wikidata.ts';

const RETRIEVED = '1970-01-01T00:00:03.000Z';

/** A synthetic EntityData body in Wikidata's shape. No real label is asserted here. */
function body(overrides: Record<string, unknown> = {}) {
  return {
    entities: {
      Q25391: {
        type: 'item',
        id: 'Q25391',
        lastrevid: 101,
        modified: '1970-01-01T00:00:00Z',
        labels: {
          en: { language: 'en', value: 'Synthetic Dune' },
          ko: { language: 'ko', value: '합성어' },
          de: { language: 'de', value: 'Not imported' },
        },
        aliases: {
          en: [
            { language: 'en', value: 'synthetic  sand hill' },
            { language: 'en', value: 'Synthetic Dune' },
          ],
        },
        descriptions: { en: { language: 'en', value: 'A synthetic description' } },
        ...overrides,
      },
    },
  };
}

test('one row per label, alias and description in the fixed languages, with the revision kept', () => {
  const { rows, leftOut } = buildTermRows(body(), 'Q25391', RETRIEVED);
  assert.deepEqual(leftOut, {});
  assert.deepEqual(
    rows.map((row) => [row.language, row.kind, row.text, row.match_key]),
    [
      ['en', 'label', 'Synthetic Dune', 'synthetic dune'],
      ['en', 'alias', 'synthetic  sand hill', 'synthetic sand hill'],
      ['en', 'description', 'A synthetic description', ''],
      ['ko', 'label', '합성어', '합성어'],
    ],
  );
  for (const row of rows) {
    assert.deepEqual(Object.keys(row), [...TERM_COLUMNS]);
    assert.equal(row.source_id, 'wikidata:Q25391');
    assert.equal(row.reference_id, 'Q25391');
    assert.equal(row.revision_id, '101');
    assert.equal(row.modified_at, '1970-01-01T00:00:00Z');
    assert.equal(row.retrieved_at, RETRIEVED);
    assert.equal(row.reference_url, 'https://www.wikidata.org/wiki/Q25391');
    assert.equal(row.license, 'CC0-1.0');
    assert.equal(row.status, 'external-unreviewed');
  }
});

test('a redirect, another entity, a missing revision or a language mismatch refuses the item', () => {
  assert.throws(() => buildTermRows(body({ id: 'Q8514' }), 'Q25391', RETRIEVED));
  assert.throws(() =>
    buildTermRows({ entities: { Q8514: body().entities.Q25391 } }, 'Q25391', RETRIEVED),
  );
  assert.throws(() => buildTermRows(body({ lastrevid: undefined }), 'Q25391', RETRIEVED));
  assert.throws(() => buildTermRows(body({ modified: 'yesterday' }), 'Q25391', RETRIEVED));
  assert.throws(() =>
    buildTermRows(
      body({ labels: { ko: { language: 'en', value: 'fallback' } } }),
      'Q25391',
      RETRIEVED,
    ),
  );
  assert.throws(() => buildTermRows(body(), 'Q1', RETRIEVED));
  assert.throws(() => buildTermRows(body(), 'Q25391', 'not a time'));
});

test('empty maps sent as arrays read as empty, and text the table cannot hold is left out and counted', () => {
  const { rows, leftOut } = buildTermRows(
    body({
      labels: {
        en: { language: 'en', value: 'Has "quotes"' },
        fr: { language: 'fr', value: 'back\\slash' },
        ar: { language: 'ar', value: 'line\nbreak' },
        ko: { language: 'ko', value: '  ' },
        kab: { language: 'kab', value: 'x'.repeat(257) },
      },
      aliases: [],
      descriptions: [],
    }),
    'Q25391',
    RETRIEVED,
  );
  assert.deepEqual(rows, []);
  assert.deepEqual(leftOut, { quote: 2, control: 1, empty: 1, length: 1 });
});

test('the match key is one fold shared by the import and the service', () => {
  assert.equal(matchKey('  Sand   Dune '), 'sand dune');
  assert.equal(matchKey('STRASSE'), matchKey('straße'));
  assert.equal(matchKey('ΟΔΟΣ'), matchKey('οδος'));
  assert.equal(matchKey('é'), matchKey('é'));
  assert.equal(matchKey('낙타'), '낙타');
});

test('the CSV quotes every field under a fixed header and the receipt names no label', () => {
  const { rows } = buildTermRows(body(), 'Q25391', RETRIEVED);
  const csv = termCsv(rows);
  const lines = csv.split('\n');
  assert.equal(lines[0], TERM_COLUMNS.map((column) => `"${column}"`).join(','));
  assert.equal(lines.length, rows.length + 2);
  assert.equal(lines.at(-1), '');
  assert.match(lines[1] ?? '', /^"wikidata:Q25391","Q25391","en","label","Synthetic Dune",/);
  const receipt = termReceipt([{ referenceId: 'Q25391', revision: 101, rows, leftOut: {} }]);
  assert.deepEqual(receipt, {
    items: 1,
    rows: 4,
    byLanguage: { en: 3, ko: 1 },
    byKind: { label: 2, alias: 1, description: 1 },
    leftOut: {},
    revisions: { Q25391: 101 },
  });
  assert.doesNotMatch(JSON.stringify(receipt), /Synthetic|합성/);
});

test('the fixed lists are the reviewed ones', () => {
  assert.deepEqual(
    [...REFERENCE_IDS],
    [
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
    ],
  );
  assert.deepEqual([...REFERENCE_LANGUAGES], ['en', 'ko', 'ar', 'ary', 'fr', 'zgh', 'shi', 'kab']);
});

test('the receipt binds the file and every row, and a changed file, row or count is refused', async () => {
  const { mkdtemp, rm, writeFile, chmod } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { rows } = buildTermRows(body(), 'Q25391', RETRIEVED);
  const csv = termCsv(rows);
  const receipt = termReceiptFile(rows, csv);
  assert.equal(receipt.rows, 4);
  assert.equal(receipt.rowSha256.length, 4);
  assert.deepEqual(parseTermCsv(csv), rows);
  const directory = await mkdtemp(join(tmpdir(), 'boopy-term-snapshot-'));
  try {
    const csvPath = join(directory, 'wikidata_term.csv');
    const receiptPath = join(directory, 'wikidata_term.receipt.json');
    await writeFile(csvPath, csv, { mode: 0o600 });
    await writeFile(receiptPath, JSON.stringify(receipt), { mode: 0o600 });
    const snapshot = await readTermSnapshot(csvPath, receiptPath);
    assert.deepEqual(snapshot.rows, rows);
    await writeFile(csvPath, csv.replace('합성어', '바뀐말'));
    await assert.rejects(readTermSnapshot(csvPath, receiptPath));
    await writeFile(csvPath, csv);
    await writeFile(
      receiptPath,
      JSON.stringify({
        ...receipt,
        rowSha256: [...receipt.rowSha256.slice(1), receipt.rowSha256[0]],
      }),
    );
    await assert.rejects(readTermSnapshot(csvPath, receiptPath));
    await writeFile(receiptPath, JSON.stringify(receipt));
    await chmod(csvPath, 0o666);
    await assert.rejects(readTermSnapshot(csvPath, receiptPath));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  assert.throws(() => parseTermCsv(csv.replace('"Q25391"', 'Q25391')));
  assert.throws(() => parseTermCsv(csv.replace(TERM_COLUMNS[0], 'id')));
});
