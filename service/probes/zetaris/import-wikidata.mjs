// Fixed read of the named Wikidata items into the reference table file for Zetaris.
// One GET per item id, in order, with a generic User-Agent and no personal data. Writes
// wikidata_term.csv, its receipt and wikidata-revisions.json into an existing private directory
// and prints counts and revision ids only. Pass --pins <file> to read the same revisions again.
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  buildTermRows,
  REFERENCE_IDS,
  termCsv,
  termReceipt,
  termReceiptFile,
} from '../../src/references/wikidata.ts';

const USER_AGENT = `Boopy-reference-import/1 (local fixed read of named entities) node/${process.versions.node}`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { pins: { type: 'string' } },
});
const [directory] = positionals;
if (positionals.length !== 1 || !isAbsolute(directory)) {
  console.error('Usage: node import-wikidata.mjs <absolute private directory> [--pins <file>]');
  process.exit(2);
}
const info = await lstat(directory);
if (!info.isDirectory() || info.mode & 0o077) {
  console.error('The output directory must be a private directory (mode 700).');
  process.exit(2);
}
const pins =
  values.pins === undefined ? {} : JSON.parse(await readFile(values.pins, 'utf8')).revisions;

const items = [];
for (const referenceId of REFERENCE_IDS) {
  const pin = pins[referenceId];
  if (pin !== undefined && !Number.isInteger(pin))
    throw new Error('A pinned revision is not a number.');
  const url = `https://www.wikidata.org/wiki/Special:EntityData/${referenceId}.json${pin === undefined ? '' : `?revision=${pin}`}`;
  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(20000),
  });
  if (response.status !== 200) {
    console.error(`Wikidata answered ${response.status} for ${referenceId}; nothing was written.`);
    process.exit(1);
  }
  const retrievedAt = new Date().toISOString();
  const { rows, leftOut, revision } = buildTermRows(
    await response.json(),
    referenceId,
    retrievedAt,
  );
  if (pin !== undefined && revision !== pin) throw new Error('Wikidata sent another revision.');
  items.push({ referenceId, revision, rows, leftOut, retrievedAt });
}

const receipt = termReceipt(items);
const rows = items.flatMap((item) => item.rows);
const csv = termCsv(rows);
await writeFile(join(directory, 'wikidata_term.csv'), csv, { flag: 'wx', mode: 0o600 });
// Boopy checks every row Zetaris returns against this receipt, kept outside Zetaris.
await writeFile(
  join(directory, 'wikidata_term.receipt.json'),
  `${JSON.stringify(termReceiptFile(rows, csv), null, 2)}\n`,
  { flag: 'wx', mode: 0o600 },
);
await writeFile(
  join(directory, 'wikidata-revisions.json'),
  `${JSON.stringify({ source: 'Wikidata EntityData', license: 'CC0-1.0', revisions: receipt.revisions, retrievedAt: Object.fromEntries(items.map((item) => [item.referenceId, item.retrievedAt])) }, null, 2)}\n`,
  { flag: 'wx', mode: 0o600 },
);
console.log(JSON.stringify(receipt));
