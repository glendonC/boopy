import assert from 'node:assert/strict';
import { test } from 'node:test';
import { displayText } from '../activity-contract.ts';
import { assessAnswer, languageName, practiceWords } from './practice.ts';

test('the term inside the recognized text is heard, whatever is around it', () => {
  assert.equal(assessAnswer('낙타', '낙타'), 'heard');
  assert.equal(assessAnswer('낙타', '낙타가 있어요.'), 'heard');
  assert.equal(assessAnswer('낙타', '  낙 타 '), 'heard');
  assert.equal(assessAnswer('chameau', 'Un Chameau!'), 'heard');
  assert.equal(assessAnswer('Dromadaire', 'dromadaire'), 'heard');
  assert.equal(assessAnswer('사구', '사구'.normalize('NFD')), 'heard');
});

test('other words in the same script are not heard; no letter of that script is unclear', () => {
  assert.equal(assessAnswer('낙타', '락타'), 'not-heard');
  assert.equal(assessAnswer('낙타', '사막이에요'), 'not-heard');
  assert.equal(assessAnswer('단봉낙타', '낙타'), 'not-heard');
  assert.equal(assessAnswer('낙타', 'Nakta'), 'unclear');
  assert.equal(assessAnswer('낙타', 'camel'), 'unclear');
  assert.equal(assessAnswer('낙타', '...'), 'unclear');
  assert.equal(assessAnswer('chameau', '낙타'), 'unclear');
  assert.equal(assessAnswer('chameau', 'chamois'), 'not-heard');
});

test('the language name comes from the runtime for any code, and stays the code when unknown', () => {
  assert.equal(languageName('ko', 'en'), 'Korean');
  assert.equal(languageName('fr', 'en'), 'French');
  assert.equal(languageName('kab', 'en'), 'Kabyle');
  assert.equal(languageName('qqq', 'en'), 'qqq');
});

test("DESIGN's settled lines, filled in and kept within the display rules as they are", () => {
  const words = practiceWords({ language: 'Korean', guess: 'camel', term: '낙타' });
  const expected = {
    first: 'My guess: camel. The Korean word for camel is 낙타. Can you say it?',
    heard: 'I heard 낙타.',
    notHeard: "I didn't hear 낙타 in that. Once more?",
    unclear: "I couldn't hear any Korean in that. Once more?",
    again: "Last time I didn't hear 낙타 from you. Try it again?",
    noMatch: "There's no Korean word for camel in the word list on your Mac.",
    ambiguous: "I'm not sure which Korean word fits camel.",
    notDisplayable: "I found a Korean word for camel, but I can't show its script yet.",
    unavailable: "Zetaris on your Mac didn't answer in time, so there's no Korean word this time.",
    integrity:
      "The word list on your Mac doesn't match what was imported, so there's no Korean word this time.",
  };
  assert.deepEqual(words, expected);
  const line = displayText(200);
  for (const text of Object.values(words)) assert.equal(line.parse(text), text);
});
