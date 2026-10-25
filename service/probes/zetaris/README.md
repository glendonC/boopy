# Zetaris probes

Local only. Credentials stay in a mode `0600` file outside git: two UTF-8 lines, username then
password. Do not put them in arguments, URLs, or logs.

## Connectivity

Fixed `SELECT 1`. A success means the driver connected. It does not mean a join ran.

```sh
node service/probes/zetaris/run.mjs /absolute/private/credential-file
node service/probes/zetaris/run.mjs /absolute/private/credential-file --metadata
```

`--metadata` prints a bounded schema count and the driver version, not schema names.

## Fixed lookups

`run-federation.mjs` accepts only `discover`, `join`, `reference`, and the setup operations
named in the script. `reference` takes one of `Q25391` (dune), `Q8514` (desert), or `Q71516`
(dromedary).

```sh
node service/probes/zetaris/run-federation.mjs /absolute/private/reader-credential-file reference Q25391
```

The service helper is `lookupZetarisReference` in `service/src/references/zetaris.ts`. It does
not accept SQL, a host, or a journal path, and it does not upload saved context.

Zero rows or duplicate rows fail. A failure does not invent a fallback row.

## The reference and practice tables

`import-wikidata.mjs` reads the fixed item list in `src/references/wikidata.ts` from Wikidata
EntityData, one GET per item, with a generic User-Agent and no personal data. It writes
`wikidata_term.csv` (one row per label, alias or description in en, ko, ar, ary, fr, zgh, shi and
kab, with the item's revision, its modified time and the time Boopy read it),
`wikidata_term.receipt.json` (the file's SHA-256 and each row's) and `wikidata-revisions.json` into
an existing mode `0700` directory, and prints counts and revision ids. `--pins wikidata-revisions.json` reads the same revisions again. Wikidata item data is CC0. The
rows are a dated snapshot, not reviewed, and never live.

```sh
node service/probes/zetaris/import-wikidata.mjs /absolute/private/directory
```

The engine holds three tables, all CSV filestore tables under
`shared/boopy/` in the stack's `customer-data` Docker volume,
outside Boopy's data directory:

- `BOOPY_TERMS.wikidata_term`, the import's file.
- `BOOPY_PRACTICE.practice_attempt`, the practice record: per spoken answer its event id,
  task id, source id, Q-id, language, result (`heard`, `not-heard` or `unclear`), the uncertain flag
  and the time. No transcript, utterance, label text, frame digest or location.
- `BOOPY_PRACTICE.practice_check`, the same shape, written only by checks.

The practice table is a projection of Boopy's journal. Each call sends the journal's rows, and the
runner rewrites the table whole when it differs. The modes `term-pick` and `practice-stage` write
`practice_attempt`; `term-pick-check` and `practice-stage-check` write `practice_check`. No mode
takes a table name, and every write statement names one of those two tables as a constant. To
empty the practice record:

```sh
printf 'end\n' | node service/probes/zetaris/run-federation.mjs /absolute/private/practice-credential-file practice-stage
```

`register-terms` and `provision-practice` run once as the setup administrator. The practice
account `boopy-practice-1970-01-01@example.invalid` has SELECT on `wikidata_term` and SELECT and
INSERT on the two practice tables; `verify-practice` proves its reads, the check table's rewrite,
and that it cannot read any other table. This engine build (2.4.3.1) does not check INSERT grants
on filestore tables: in a probe, the account appended to and rewrote a scratch table it had no
grant on. Only Boopy's fixed statements keep the account to its two practice tables, and any
Zetaris login on this Mac could rewrite the term table. So Boopy checks every term row a pick
returns against the import's receipt, kept outside Zetaris; a row that differs fails the pick as an
integrity failure and is never shown.

`term-pick` is one fixed query, `term-pick-v1`: the items whose label or alias in the person's
language has exactly the match key of Boopy's guess, plus Q-ids recalled from earlier practice, each
with its label in the target language, its label and description in the person's language, and its
practice record in the target language with excluded tasks left out. Values are bound as parameters
after the runner checks them; table names come from a closed list.
