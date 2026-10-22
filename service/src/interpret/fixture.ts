import type { Interpreter, InterpretInput, InterpretResult } from './interpreter.ts';
import type { ModelOutput } from './output.ts';

/**
 * A recorded interpretation, labelled as such everywhere it appears (provider `fixture`). For
 * tests, and for exercising the headset when no model is available. It places its items around
 * the main cue so they land where the person looked.
 */
export class FixtureInterpreter implements Interpreter {
  readonly provider = 'fixture';
  readonly model = 'recorded-desert-trip';

  async interpret(input: InterpretInput): Promise<InterpretResult> {
    const output = desertTrip(input);
    return { output, raw: JSON.stringify(output) };
  }
}

function desertTrip(input: InterpretInput): ModelOutput {
  const focus = input.pointer ?? input.gaze ?? { x: 0.5, y: 0.5 };
  const at = (dx: number, dy: number, w: number, h: number) => {
    const x = Math.min(1 - w, Math.max(0, focus.x + dx - w / 2));
    const y = Math.min(1 - h, Math.max(0, focus.y + dy - h / 2));
    return [x, y, x + w, y + h].map((value) => Math.round(value * 1000));
  };
  const scene = input.scope === 'scene';
  return {
    scope: scene ? 'scene' : 'object',
    referent: {
      key: scene ? null : 'photo',
      basis: scene ? 'scene' : input.pointer ? 'pointer' : 'gaze',
      alternatives: [],
    },
    intent: {
      label: 'Talk about the trip',
      statement: 'Practice telling the story of this desert trip in Korean.',
      kind: 'learn',
      targetLanguage: 'ko',
      confidence: 0.8,
    },
    items: [
      {
        key: 'photo',
        kind: 'object',
        label: 'Desert photo',
        gloss: null,
        statement: 'A photo of a desert trip with dunes and camels.',
        box: at(0, 0, 0.36, 0.3),
        point: null,
        scene: false,
        confidence: 0.85,
        why: 'It is under the cue.',
      },
      {
        key: 'camels',
        kind: 'object',
        label: 'Camels',
        gloss: '낙타',
        statement: 'Camels stand on the dunes in the photo.',
        box: at(-0.08, 0.04, 0.12, 0.1),
        point: null,
        scene: false,
        confidence: 0.7,
        why: 'Animal shapes in the photo.',
      },
      {
        key: 'tents',
        kind: 'object',
        label: 'Tents',
        gloss: '텐트',
        statement: 'Small tents near the dunes suggest a camp.',
        box: at(0.1, 0.08, 0.1, 0.08),
        point: null,
        scene: false,
        confidence: 0.4,
        why: 'Low shapes that may be tents.',
      },
      {
        key: 'landscape',
        kind: 'topic',
        label: 'Describing the landscape',
        gloss: '풍경 묘사',
        statement: 'Describe the dunes, sand and sky.',
        box: null,
        point: null,
        scene: true,
        confidence: 0.75,
        why: 'The scene is mostly landscape.',
      },
      {
        key: 'arrival',
        kind: 'topic',
        label: 'How you got there',
        gloss: null,
        statement: 'Recount how you travelled to this place.',
        box: null,
        point: null,
        scene: true,
        confidence: 0.6,
        why: 'Trips are usually told from the journey.',
      },
      {
        key: 'past',
        kind: 'grammar',
        label: 'Past tense',
        gloss: '-았/었어요',
        statement: 'Telling a trip needs past-tense verb endings.',
        box: null,
        point: null,
        scene: true,
        confidence: 0.8,
        why: 'The trip is over.',
      },
      {
        key: 'desert',
        kind: 'vocabulary',
        label: 'desert',
        gloss: '사막',
        statement: 'The word for desert.',
        box: null,
        point: null,
        scene: true,
        confidence: 0.9,
        why: 'Central to the scene.',
      },
    ],
    relations: [
      { from: 'camels', to: 'photo', kind: 'part_of', label: null },
      { from: 'past', to: 'arrival', kind: 'supports_goal', label: null },
    ],
    questions: [{ text: 'Where was this trip?', about: 'photo' }],
  };
}
