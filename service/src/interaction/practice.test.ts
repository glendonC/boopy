import assert from 'node:assert/strict';
import { test } from 'node:test';
import { displayText } from '../activity-contract.ts';
import { assessAnswer, earlierPracticeLine, languageName, practiceWords } from './practice.ts';

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

test('the lines, filled in and kept within the display rules as they are', () => {
  const words = practiceWords({ language: 'Korean', guess: 'camel', term: '낙타' });
  const expected = {
    first: "Camel, I think. In Korean, that's 낙타. Can you say it?",
    unsure: "Camel? I'm not sure. In Korean, that's 낙타. Can you say it?",
    heard: 'I heard 낙타.',
    notHeard: "I didn't catch 낙타 there. Try again?",
    unclear: "I didn't hear any Korean there. Try again?",
    again: "Last time 낙타 didn't come through. Want to try again?",
    heardBefore: 'Camel, I think. Last time I heard 낙타. Can you say it again?',
    heardBeforeUnsure: "Camel? I'm not sure. Last time I heard 낙타. Can you say it again?",
    noMatch: "I don't have a Korean word for camel yet.",
    ambiguous: 'Not sure which word fits this.',
    notDisplayable: "I can't show that word's letters yet.",
    unavailable: "Couldn't get the Korean word this time.",
    integrity: "Couldn't get the Korean word this time.",
  };
  assert.deepEqual(words, expected);
  const line = displayText(200);
  for (const text of Object.values(words)) assert.equal(line.parse(text), text);
  assert.equal(earlierPracticeLine('낙타', 'camel'), 'You tried 낙타 (camel) before.');
  assert.match(
    practiceWords({ language: 'Korean', guess: '낙타', term: '낙타' }).first,
    /^낙타, I think/,
  );
});
