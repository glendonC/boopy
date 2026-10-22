import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { it } from 'node:test';

it('local synthetic federation adds independent evidence without verifying personal history', () => {
  const fixture = JSON.parse(
    readFileSync(new URL('../fixtures/zetaris/synthetic.json', import.meta.url), 'utf8'),
  ) as { status: string; context: (string | number | null)[][]; references: string[][] };
  assert.equal(fixture.status, 'synthetic-local-contract-not-zetaris-runtime');
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE selected_context (
      package_id TEXT, evidence_id TEXT, revision_id TEXT, concept_key TEXT, context_text TEXT,
      captured_at TEXT, human_verification TEXT, model_confidence REAL, superseded_by TEXT,
      export_grant_id TEXT);
      CREATE TABLE independent_reference (
      reference_id TEXT, concept_key TEXT, korean_term TEXT, reference_version TEXT,
      updated_at TEXT, reference_status TEXT, reference_url TEXT);`);
    const contextInsert = db.prepare('INSERT INTO selected_context VALUES (?,?,?,?,?,?,?,?,?,?)');
    const referenceInsert = db.prepare('INSERT INTO independent_reference VALUES (?,?,?,?,?,?,?)');
    for (const row of fixture.context) contextInsert.run(...row);
    for (const row of fixture.references) referenceInsert.run(...row);
    const before = db.prepare('SELECT * FROM selected_context ORDER BY evidence_id').all();
    const query = db.prepare(
      readFileSync(new URL('../fixtures/zetaris/join.sql', import.meta.url), 'utf8'),
    );
    const parameters = { package_id: 'synthetic-trip-1', grant_id: 'synthetic-grant-1' };
    const rows = query.all(parameters);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.evidence_id, 'dune-1');
    assert.equal(rows[0]?.human_verification, 'unconfirmed');
    assert.equal(rows[0]?.model_confidence, 0.62);
    assert.equal(rows[0]?.korean_term, '모래 언덕');
    assert.equal(rows[0]?.reference_status, 'synthetic-unreviewed');
    assert.equal(rows[0]?.reference_id, 'synthetic-glossary-1');
    db.prepare('UPDATE independent_reference SET reference_version = ? WHERE reference_id = ?').run(
      'version-2',
      'synthetic-glossary-1',
    );
    assert.equal(query.all(parameters)[0]?.reference_version, 'version-2');
    assert.deepEqual(
      db.prepare('SELECT * FROM selected_context ORDER BY evidence_id').all(),
      before,
    );
    assert.equal(query.all({ ...parameters, grant_id: 'missing-grant' }).length, 0);
    db.prepare('UPDATE selected_context SET model_confidence = NULL WHERE evidence_id = ?').run(
      'dune-1',
    );
    assert.equal(query.all(parameters)[0]?.model_confidence, null);
    db.prepare('UPDATE selected_context SET human_verification = ? WHERE evidence_id = ?').run(
      'rejected',
      'dune-1',
    );
    assert.equal(query.all(parameters).length, 0);
  } finally {
    db.close();
  }
});
