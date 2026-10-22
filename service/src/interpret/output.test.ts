import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  editDistance,
  gridBox,
  gridPoint,
  InterpretError,
  type ModelOutput,
  normalize,
  outputJsonSchema,
  parseModelText,
  writtenAs,
} from './output.ts';

const output: ModelOutput = {
  scope: 'object',
  referent: { key: 'photo', basis: 'pointer', alternatives: [] },
  intent: {
    label: 'Talk',
    statement: 'Talk about it.',
    kind: 'learn',
    targetLanguage: 'ko',
    confidence: 80,
  },
  items: [
    {
      key: 'photo',
      kind: 'Object',
      label: ' Photo ',
      gloss: null,
      statement: 'A photo.',
      box: [600, 500, 300, 200],
      point: null,
      scene: false,
      confidence: 0.9,
      why: '',
    },
    {
      key: 'notes',
      kind: 'text',
      label: 'Notes',
      gloss: '',
      statement: 'Notes.',
      box: [100, 100, 500, 300],
      point: null,
      scene: false,
      confidence: 0.5,
      why: 'Text.',
    },
    {
      key: 'idea',
      kind: 'topic',
      label: 'Idea',
      gloss: '생각',
      statement: 'An idea.',
      box: [10, 10, 10, 10],
      point: [500, 250],
      scene: false,
      confidence: 0.4,
      why: '',
    },
  ],
  relations: [
    { from: 'idea', to: 'photo', kind: 'about', label: null },
    { from: 'idea', to: 'missing', kind: 'about', label: null },
  ],
  questions: [{ text: 'Where?', about: 'photo' }],
};

describe('grid conversion', () => {
  it('turns 0 to 1000 boxes into unit boxes with ordered corners', () => {
    assert.deepEqual(gridBox([600, 500, 300, 200]), { x0: 0.3, y0: 0.2, x1: 0.6, y1: 0.5 });
  });
  it('drops boxes without area and malformed ones', () => {
    assert.equal(gridBox([10, 10, 10, 10]), null);
    assert.equal(gridBox([1, 2, 3]), null);
    assert.equal(gridBox(null), null);
  });
  it('accepts values already on a unit scale', () => {
    assert.deepEqual(gridBox([0.1, 0.2, 0.3, 0.4]), { x0: 0.1, y0: 0.2, x1: 0.3, y1: 0.4 });
    assert.deepEqual(gridPoint([500, 250]), { x: 0.5, y: 0.25 });
  });
});

describe('normalize', () => {
  const normalized = normalize(output, {
    interpretationId: 'int_1',
    observationId: 'obs_1',
    scope: 'auto',
    text: [
      { text: '사막 = desert', confidence: 1, box: { x0: 0.12, y0: 0.12, x1: 0.3, y1: 0.15 } },
      { text: 'far away', confidence: 1, box: { x0: 0.8, y0: 0.8, x1: 0.9, y1: 0.9 } },
    ],
  });
  const byLabel = (label: string) => normalized.items.find((item) => item.label === label);

  it('proposes every item from the model, never confirms one', () => {
    assert.ok(
      normalized.items.every((item) => item.status === 'proposed' && item.origin === 'model'),
    );
  });
  it('puts the intent first as a goal and scales a percentage confidence', () => {
    assert.equal(normalized.items[0]?.kind, 'goal');
    assert.equal(normalized.items[0]?.id, normalized.intentId);
    assert.equal(normalized.items[0]?.confidence, 0.8);
  });
  it('grounds boxes in the observation and falls back to a point', () => {
    assert.deepEqual(byLabel('Photo')?.grounding, {
      kind: 'box',
      observationId: 'obs_1',
      box: { x0: 0.3, y0: 0.2, x1: 0.6, y1: 0.5 },
    });
    assert.deepEqual(byLabel('Idea')?.grounding, {
      kind: 'point',
      observationId: 'obs_1',
      point: { x: 0.5, y: 0.25 },
    });
  });
  it('backs text items with the exact OCR lines they cover', () => {
    assert.deepEqual(byLabel('Notes')?.text, ['사막 = desert']);
  });
  it('keeps relations whose ends exist and resolves the referent', () => {
    assert.equal(normalized.relations.length, 1);
    assert.equal(normalized.referentId, byLabel('Photo')?.id);
  });
  it('turns questions into question items grounded where they point', () => {
    const question = normalized.items.find((item) => item.kind === 'question');
    assert.equal(question?.label, 'Where?');
    assert.equal(question?.grounding.kind, 'box');
    assert.equal(question?.confidence, null);
  });
  it('forces the scene scope when the person asked for it', () => {
    const scene = normalize(output, {
      interpretationId: 'i',
      observationId: 'o',
      scope: 'scene',
      text: [],
    });
    assert.equal(scene.scope, 'scene');
  });
});

describe('parseModelText', () => {
  it('reads JSON inside a fenced block', () => {
    const parsed = parseModelText(`Here:\n\`\`\`json\n${JSON.stringify(output)}\n\`\`\``);
    assert.equal(parsed.items.length, 3);
  });
  it('refuses answers that are not the schema', () => {
    assert.throws(() => parseModelText('{"scope": "object"}'), InterpretError);
    assert.throws(() => parseModelText('no json here'), InterpretError);
  });
});

describe('outputJsonSchema', () => {
  it("closes every object and requires every property, as Meta's strict mode needs", () => {
    const visit = (node: unknown): void => {
      if (Array.isArray(node)) {
        node.forEach(visit);
        return;
      }
      if (node === null || typeof node !== 'object') return;
      const object = node as Record<string, unknown>;
      if (object.type === 'object') {
        assert.equal(object.additionalProperties, false);
        assert.deepEqual(object.required, Object.keys(object.properties as object));
      }
      Object.values(object).forEach(visit);
    };
    visit(outputJsonSchema());
  });
});

describe('OCR is the record of text', () => {
  const line = {
    text: '모로코에 갓어요. (I went to Morocco.)',
    confidence: 1,
    box: { x0: 0.18, y0: 0.35, x1: 0.66, y1: 0.4 },
  };
  const withLabel = (label: string): ModelOutput => ({
    ...output,
    items: [
      {
        key: 'sentence',
        kind: 'text_segment',
        label,
        gloss: null,
        statement: "Sentence meaning 'I went to Morocco.'",
        box: [180, 350, 660, 400],
        point: null,
        scene: false,
        confidence: 0.9,
        why: '',
      },
    ],
    relations: [],
    questions: [],
  });
  const context = {
    interpretationId: 'int_9',
    observationId: 'obs_9',
    scope: 'auto' as const,
    text: [line],
  };

  it('finds the written words inside a longer line', () => {
    assert.equal(editDistance('갔어요', '갓어요'), 1);
    assert.equal(writtenAs('모로코에 갔어요.', line.text), '모로코에 갓어요.');
    assert.equal(writtenAs('모로코에 갔어요 (I went to Morocco)', line.text), line.text);
    assert.equal(writtenAs('camel', line.text), null);
  });

  it('keeps the text as written when the model silently corrected it, and asks', () => {
    const normalized = normalize(withLabel('모로코에 갔어요.'), context);
    const sentence = normalized.items.find((item) => item.id === 'int_9.sentence');
    assert.equal(sentence?.label, '모로코에 갓어요.');
    assert.deepEqual(sentence?.text, [line.text]);
    const question = normalized.items.find((item) => item.kind === 'question');
    assert.equal(
      question?.label,
      'The text says "갓어요" where the model expected "갔어요". Is that a mistake in the text?',
    );
    assert.deepEqual(question?.grounding, sentence?.grounding);
  });

  it('asks nothing when the model read the text as written, whatever the punctuation', () => {
    for (const label of ['모로코에 갓어요.', '모로코에 갓어요 (I went to Morocco)']) {
      const normalized = normalize(withLabel(label), context);
      assert.equal(normalized.items.filter((item) => item.kind === 'question').length, 0, label);
    }
  });
});
