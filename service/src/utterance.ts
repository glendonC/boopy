/**
 * What a person's words ask Boopy to do. Read with fixed rules, so the same words always do the
 * same thing and nothing a model guesses becomes a correction. Words that match no rule are a new
 * question about the world, or, when the person was pointing at a card, a note on that card.
 */
export type Reading =
  | { readonly kind: 'commit' }
  | {
      readonly kind: 'item';
      readonly action: 'confirm' | 'reject' | 'ignore' | 'known' | 'matters';
      readonly reason?: string;
    }
  | { readonly kind: 'relabel'; readonly label: string }
  | { readonly kind: 'add'; readonly text: string }
  | { readonly kind: 'rescope'; readonly scope: 'scene' }
  | { readonly kind: 'refocus' }
  | { readonly kind: 'note'; readonly text: string }
  | { readonly kind: 'ask' };

// Conservative question/request cues run before correction rules. Modal requests such as
// "can you confirm this" ask about an action; they never establish human verification.
// This is bounded syntax recognition, not a general natural-language intent classifier.
const QUESTION_START =
  /^(?:please[,\s]+)?(?:what|why|how|when|where|who|which|whose|whom|is|are|am|was|were|do|does|did|can|could|may|might|should|would|will|have|has|had)\b/;
const CONTRACTED_QUESTION =
  /^(?:please[,\s]+)?(?:isn't|aren't|wasn't|weren't|don't|doesn't|didn't|haven't|hasn't|hadn't|can't|couldn't|won't|wouldn't|shouldn't|mustn't|mightn't)\s+(?:i|you|we|he|she|they|it|this|that|these|those|the|a|an)\b/;
const NEGATED_MUTATION_REQUEST =
  /^(?:please[,\s]+)?(?:do not|don't|never)\s+(?:confirm|accept|ignore|skip|reject|remove|save|commit|send|rename|relabel|call|add|include|mark)\b/;
const EXPLANATION_REQUEST = /^(?:please[,\s]+)?(?:translate|explain|describe)\b/;
// These explicit hedges are personal statements, not evidence verification. Retain the
// person's exact words on a selected item; do not interpret embedded command phrases.
const UNCERTAINTY_START =
  /^(?:maybe|perhaps|possibly|probably|i (?:think|guess|suppose|wonder|suspect|doubt)|i(?:'m| am) (?:not sure|unsure|uncertain)|i (?:do not|don't) (?:already )?know|not sure|unsure|uncertain)\b/;
// Explicit interrogative forms only; polite Korean -요 alone is not a question cue.
const KOREAN_QUESTION = /(?:무엇인가요|뭐예요|뭐에요|맞나요|어떻게\s*말하나요)\s*$/;

const COMMIT =
  /^(?:ok(?:ay)?[,\s]+)?(?:please\s+)?(?:save|commit|send)\b|^(?:that'?s all|i'?m done|all done|done)$/;
const SCENE =
  /\b(?:whole|entire)\s+(?:scene|room|place|view|picture|thing|area|space|photo|page)\b|\beverything\s+(?:here|around)\b|\buse\s+(?:it\s+)?all\b|\ball of (?:this|it)\b/;
const REFOCUS =
  /^(?:no[,.]?\s+)?(?:i mean (?:this|that)(?: one)?|(?:this|that) is what i mean|that'?s what i mean|this one|not that[,.]?\s+this(?: one)?)\b/;
const KNOWN =
  /\bi (?:already )?know (?:this|that|it|these|those)\b|\balready know\b|\bi'?ve (?:already )?learned (?:this|that|it)\b/;
const IGNORE =
  /\b(?:ignore|skip) (?:this|that|it|these|those)\b|\b(?:doesn'?t|does not) matter\b|\bnot (?:important|relevant)\b|\birrelevant\b/;
const MATTERS =
  /\b(?:this|that|it) (?:really )?matters\b|\b(?:this|that|it) is (?:really |very )?important\b|\bfocus on (?:this|that)\b|\bkeep (?:this|that)\b/;
const RELABEL =
  /^(?:no[,.]?\s+)?(?:it'?s|that'?s|this is|these are|those are|they'?re|call (?:it|this|that)|rename (?:it|this|that)(?: to)?)\s+(?:actually\s+)?(?:a |an |the )?(.+)$/;
const NOT_A_LABEL = /^(?:right|correct|true|it|wrong|not\b|what i mean|all|good|fine|ok(?:ay)?)/;
const REJECT =
  /^(?:no[,.]?\s*)?(?:not (?:that|this|it|these|those)|that'?s (?:wrong|not (?:it|right|true|correct))|wrong|remove (?:this|that|it)|no)\b/;
const CONFIRM =
  /^(?:yes|yeah|yep|yup|right|correct|exactly|true|that'?s (?:right|correct|true|it)|good|ok(?:ay)?|sure|confirm(?:ed)?)\b/;
const ADD =
  /^(?:and also|also|add|plus|include|i also want to|i'?d also like to|also i want to)\b[,\s]*(.*)$/;
// Match the same command prefix in the original text; normalization is for recognition only.
const ORIGINAL_ADD =
  /^(?:and\s+also|also|add|plus|include|i\s+also\s+want\s+to|i['‘’]?d\s+also\s+like\s+to|also\s+i\s+want\s+to)\b[,\s]*([\s\S]*)$/i;

/** Lowercase, plain apostrophes, no trailing punctuation or space. */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!?]+$/, '')
    .trim();
}

export function readUtterance(text: string, targeted: boolean): Reading {
  const said = normalize(text);
  if (said === '') return { kind: 'ask' };
  if (
    /[?？]/.test(text) ||
    QUESTION_START.test(said) ||
    CONTRACTED_QUESTION.test(said) ||
    NEGATED_MUTATION_REQUEST.test(said) ||
    EXPLANATION_REQUEST.test(said) ||
    KOREAN_QUESTION.test(said)
  )
    return { kind: 'ask' };
  if (UNCERTAINTY_START.test(said))
    return targeted ? { kind: 'note', text: text.trim() } : { kind: 'ask' };
  if (COMMIT.test(said)) return { kind: 'commit' };
  if (SCENE.test(said)) return { kind: 'rescope', scope: 'scene' };
  if (REFOCUS.test(said)) return { kind: 'refocus' };
  if (KNOWN.test(said)) return { kind: 'item', action: 'known' };
  if (IGNORE.test(said)) return { kind: 'item', action: 'ignore' };
  if (MATTERS.test(said)) return { kind: 'item', action: 'matters' };
  const relabel = RELABEL.exec(said);
  if (relabel?.[1] !== undefined && !NOT_A_LABEL.test(relabel[1]) && targeted) {
    return { kind: 'relabel', label: relabel[1].trim() };
  }
  const reject = REJECT.exec(said);
  if (reject !== null) {
    const reason = said
      .slice(reject[0].length)
      .replace(/^[\s,.;:-]+/, '')
      .replace(/^because\s+/, '')
      .trim();
    return reason === ''
      ? { kind: 'item', action: 'reject' }
      : { kind: 'item', action: 'reject', reason };
  }
  if (CONFIRM.test(said)) return { kind: 'item', action: 'confirm' };
  const add = ADD.exec(said);
  if (add?.[1] !== undefined && add[1] !== '') {
    const original = ORIGINAL_ADD.exec(text.trim());
    if (original?.[1] !== undefined) return { kind: 'add', text: original[1].trim() };
  }
  return targeted ? { kind: 'note', text: text.trim() } : { kind: 'ask' };
}

/** Whether a reading acts on one item and therefore needs a target. */
export function needsTarget(reading: Reading): boolean {
  return reading.kind === 'item' || reading.kind === 'relabel' || reading.kind === 'note';
}
