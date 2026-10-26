/**
 * What Boopy heard in a spoken answer against an outside term, and the lines it says around it. The
 * recognizer gives no confidence, so a result is never "right": heard means the term's letters were
 * in the recognized text; not-heard means letters of the term's script were recognized but not the
 * term; unclear means no letter of that script was recognized at all. The recognizer may be at fault,
 * so none of these says how well the person speaks. Lines never quote what was recognized.
 */
import { matchKey } from '../references/wikidata.ts';

export type Heard = 'heard' | 'not-heard' | 'unclear';

/** Scripts the unclear check can tell apart. A term in another script is only heard or not-heard. */
const SCRIPTS = [
  /\p{Script=Latin}/u,
  /\p{Script=Hangul}/u,
  /\p{Script=Arabic}/u,
  /\p{Script=Tifinagh}/u,
  /\p{Script=Han}/u,
  /\p{Script=Hiragana}/u,
  /\p{Script=Katakana}/u,
  /\p{Script=Cyrillic}/u,
  /\p{Script=Greek}/u,
  /\p{Script=Hebrew}/u,
  /\p{Script=Devanagari}/u,
  /\p{Script=Thai}/u,
];

/** Letters, marks and digits only, folded the way labels are matched. */
function letters(text: string): string {
  return matchKey(text).replace(/[^\p{L}\p{M}\p{N}]/gu, '');
}

export function assessAnswer(term: string, recognized: string): Heard {
  const wanted = letters(term);
  const heard = letters(recognized);
  if (wanted !== '' && heard.includes(wanted)) return 'heard';
  const scripts = SCRIPTS.filter((script) => script.test(wanted));
  if (scripts.length > 0 && !scripts.some((script) => script.test(heard))) return 'unclear';
  return 'not-heard';
}

/** A language's name in the person's language, from the runtime's own data; the code when unknown. */
export function languageName(code: string, personLanguage: string): string {
  try {
    return (
      new Intl.DisplayNames([personLanguage], { type: 'language', fallback: 'none' }).of(code) ??
      code
    );
  } catch {
    return code;
  }
}

/**
 * The lines Boopy says around an outside term, the same for any language. The guess is
 * Boopy's guess as the model proposed it; the term is the outside term exactly as the source has it.
 */
export function practiceWords(input: {
  readonly language: string;
  readonly guess: string;
  readonly term: string;
}) {
  const { language, guess, term } = input;
  // The guess opens the line, so its first letter is capitalized; a script without case is unchanged.
  const [first = '', ...rest] = guess;
  const opening = `${first.toUpperCase()}${rest.join('')}`;
  const unavailable = `Couldn't get the ${language} word this time.`;
  return {
    first: `${opening}, I think. In ${language}, that's ${term}. Can you say it?`,
    unsure: `${opening}? I'm not sure. In ${language}, that's ${term}. Can you say it?`,
    heard: `I heard ${term}.`,
    notHeard: `I didn't catch ${term} there. Try again?`,
    unclear: `I didn't hear any ${language} there. Try again?`,
    again: `Last time ${term} didn't come through. Want to try again?`,
    noMatch: `I don't have a ${language} word for ${guess} yet.`,
    ambiguous: 'Not sure which word fits this.',
    notDisplayable: "I can't show that word's letters yet.",
    // An outage, a timeout and rows that differ from the import read the same on screen; the
    // journal and the trace keep which one it was.
    unavailable,
    integrity: unavailable,
  };
}

/** The Detail: where the term came from. Its revision and review state stay in the journal. */
export const SOURCE_LINE = 'Wikidata · Zetaris';

/** The Detail's second line, for a concept recalled from earlier practice; never on the subject. */
export function earlierPracticeLine(term: string, concept: string): string {
  return `You tried ${term} (${concept}) before.`;
}
