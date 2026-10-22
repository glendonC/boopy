/** Audit tests that wait for a lead decision before they bind the backend (not contract text yet). */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { displayText, readActivityFile, readContainer } from '../activity-contract.ts';

const file = JSON.stringify({
  type: 'boopy.activity',
  version: 1,
  binding: { requestId: 'arq_audit1', packageId: 'ctx_audit1', packetSha256: 'a'.repeat(64) },
  fallbackText: 'Synthetic fallback.',
  activity: {},
});

test('audit U1 decision: a json fence beside any other fenced block is unreadable', () => {
  // Section 10a says "exactly one fenced block, labelled json"; U1 reads the one labelled json.
  assert.equal(readContainer(`\`\`\`text\nhello\n\`\`\`\n\`\`\`json\n${file}\n\`\`\``), null);
  assert.equal(
    readContainer(`\`\`\`json\n${file}\n\`\`\`\n\`\`\`\n{"type":"other"}\n\`\`\``),
    null,
  );
  assert.equal(readContainer(`\`\`\`json\n${file}\n\`\`\`\n\`\`\`text\nunclosed`), null);
});

test('audit U1 decision: Hangul fillers, which render blank, are not displayable', () => {
  for (const value of [
    '\u{3164}',
    '\u{ffa0}',
    '\u{115f}',
    '\u{1160}',
    '\u{b099}\u{d0c0}\u{3164}',
    'Grok\u{3164}Bot',
  ])
    assert.equal(displayText(60).safeParse(value).success, false, JSON.stringify(value));
});

test('audit U1 decision: issue text never repeats a link-like field name from the file', () => {
  for (const key of ['https://evil.example/x', 'www.evil.example', 'javascript:alert(1)']) {
    const read = readActivityFile(`{${JSON.stringify(key)}:1,${file.slice(1)}`);
    assert.equal(read.kind, 'invalid');
    for (const issue of read.kind === 'invalid' ? read.issues : [])
      assert.doesNotMatch(issue, /[a-z][a-z0-9+.-]*:\/\/|www\.|javascript:/i, issue);
  }
});
