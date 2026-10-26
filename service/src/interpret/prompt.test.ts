import assert from 'node:assert/strict';
import { it } from 'node:test';
import { prepareEvidence } from '../evidence.ts';
import { fixtureJpeg } from '../testing.ts';
import { FixtureInterpreter } from './fixture.ts';
import type { InterpretInput } from './interpreter.ts';
import { ModelOutput, outputJsonSchema } from './output.ts';
import { SYSTEM_PROMPT, userText } from './prompt.ts';

const input: InterpretInput = {
  said: 'What is this called in Korean?',
  language: 'en',
  scope: 'auto',
  gaze: null,
  pointer: null,
  image: fixtureJpeg('desert-photo.jpg'),
  crop: null,
  text: [
    { text: 'Synthetic OCR 원문', confidence: 0.8, box: { x0: 0.7, y0: 0.7, x1: 0.9, y1: 0.9 } },
  ],
  decisions: [],
  selectedReference: {
    itemId: 'synthetic-item',
    observationId: 'synthetic-old-view',
    label: 'Synthetic candidate',
    statement: 'A model proposal, not a personal fact.',
    verification: 'accepted',
    disposition: 'proposed',
    confidence: null,
    box: { x0: 0.7, y0: 0.7, x1: 0.9, y1: 0.9 },
    text: ['Synthetic OCR 원문'],
    note: 'I pointed here; I did not confirm its name.',
  },
};

it('the shared prompt carries the exact selected reference separately from OCR and verification', () => {
  const text = userText(input);
  assert.ok(text.includes(JSON.stringify(input.selectedReference)));
  assert.ok(text.includes('Synthetic OCR 원문'));
  assert.ok(text.includes('Selection is not confirmation'));
  assert.ok(text.includes('No cue points were captured.'));
  assert.ok(SYSTEM_PROMPT.includes('It is not a hand or head cue'));
  assert.ok(SYSTEM_PROMPT.includes('Do not create a lesson or schedule'));
  assert.ok(SYSTEM_PROMPT.includes('act as a second tutor'));
  assert.ok(SYSTEM_PROMPT.includes('or speak as Grok or Muse'));
  assert.ok(SYSTEM_PROMPT.includes('claim any external assistant received context'));
  assert.equal(input.selectedReference?.confidence, null);
});

it('an explicit target crop uses its own location rather than an old head or hand cue', async () => {
  const jpeg = fixtureJpeg('desert-photo.jpg');
  const staleCues = { gaze: { x: 0.1, y: 0.1 }, pointer: { x: 0.2, y: 0.2 } };
  const original = await prepareEvidence(jpeg, staleCues);
  const targeted = await prepareEvidence(jpeg, { gaze: null, pointer: null }, { x: 0.8, y: 0.8 });
  assert.ok(original.crop && targeted.crop);
  assert.ok(targeted.crop.region.x0 > original.crop.region.x1);
  assert.ok(targeted.crop.region.y0 >= original.crop.region.y1);
  assert.ok(targeted.crop.region.x0 <= 0.8 && targeted.crop.region.x1 >= 0.8);
  assert.ok(targeted.crop.region.y0 <= 0.8 && targeted.crop.region.y1 >= 0.8);
  const noGeometry = await prepareEvidence(jpeg, { gaze: null, pointer: null });
  assert.equal(noGeometry.crop, null);
  assert.deepEqual(noGeometry.marked, jpeg);
});

it('old model output remains readable and direct answers are bounded proposals in the new schema', async () => {
  const { output } = await new FixtureInterpreter().interpret(input);
  assert.equal(ModelOutput.safeParse(output).success, true);
  assert.equal(ModelOutput.safeParse({ ...output, response: null }).success, true);
  assert.equal(
    ModelOutput.safeParse({ ...output, response: 'Synthetic suggested answer.' }).success,
    true,
  );
  assert.equal(ModelOutput.safeParse({ ...output, response: 'x'.repeat(1201) }).success, false);
  const schema = outputJsonSchema();
  assert.ok((schema.required as string[]).includes('response'));
});

// Instruction regression only: live provider obedience needs a separate runtime probe.
it('names the referent in the person language and leaves other languages to the word list', () => {
  assert.ok(
    SYSTEM_PROMPT.includes(
      'Never write a word or phrase in another language, a transliteration or a translation',
    ),
  );
  assert.ok(SYSTEM_PROMPT.includes('Boopy finds words in other languages in its own word list'));
  assert.ok(SYSTEM_PROMPT.includes('name the photograph rather than silently switching'));
  assert.ok(SYSTEM_PROMPT.includes('ask which visible candidate they mean'));
  assert.ok(SYSTEM_PROMPT.includes('Never replace the naming with an unrelated question'));
  assert.ok(
    SYSTEM_PROMPT.includes(
      'Do not invent a missing candidate or treat a proposed label as verified',
    ),
  );
  assert.doesNotMatch(SYSTEM_PROMPT, /\p{Script=Hangul}|Korean for|in Korean/u);
  const firstTurn = { ...input, selectedReference: undefined };
  const first = userText(firstTurn);
  const followup = userText(input);
  assert.ok(first.includes(input.said) && followup.includes(input.said));
  assert.ok(!first.includes('explicitly addressed this recorded reference'));
  assert.ok(followup.includes('Selection is not confirmation'));
});

it('asks for the subject as a short singular noun and never a gloss', () => {
  assert.ok(SYSTEM_PROMPT.includes('a short singular common noun of one or two words'));
  assert.ok(SYSTEM_PROMPT.includes('never a description, a place or a phrase'));
  assert.ok(SYSTEM_PROMPT.includes('gloss is always null'));
  assert.ok(
    userText({ ...input, view: 'gaze-crop' }).includes(
      'Image 1 is the part of the frame around where the person is looking',
    ),
  );
  assert.ok(!userText(input).includes('around where the person is looking'));
});

it('keeps contextual Boopy answers separate from either downstream assistant and unverified delivery', () => {
  assert.match(
    SYSTEM_PROMPT,
    /chosen downstream assistant \(Grok or Muse\) owns longer teaching and planning/,
  );
  assert.match(SYSTEM_PROMPT, /Do not create a lesson or schedule/);
  assert.match(SYSTEM_PROMPT, /claim any external assistant received context/);
  assert.match(SYSTEM_PROMPT, /or speak as Grok or Muse/);
  assert.match(SYSTEM_PROMPT, /short contextual answer, not a lesson/);
  assert.doesNotMatch(SYSTEM_PROMPT, /Muse owns teaching and planning/);
});

it('the shared prompt and the words Boopy adds carry no em dash', () => {
  const emDash = String.fromCharCode(0x2014);
  assert.equal(SYSTEM_PROMPT.includes(emDash), false);
  assert.equal(userText(input).includes(emDash), false);
});

it('says a recorded frame is recorded, with its place in the file and no capture time value', () => {
  for (const [capturedAt, timeLine] of [
    ['2001-02-03T04:05:06.600Z', 'Capture time: from the file, not verified.'],
    [null, 'Capture time: unknown.'],
  ] as const) {
    const text = userText({
      ...input,
      sourceContext: {
        source: 'past-recollection',
        capturedAt,
        timestampTrusted: false,
        selectionReason: 'Inspect the selected recorded frame.',
        recorded: { seconds: 4.2 },
      },
    });
    assert.ok(
      text.includes("Selected source: a frame of the person's own recording, 4.2 s into it."),
    );
    assert.ok(text.includes(timeLine));
    assert.equal(text.includes('2001'), false, 'the capture time value stays out of the prompt');
    assert.ok(text.includes('This is recorded footage, not what the person sees around them.'));
    // Nothing in Boopy's own lines about a recorded frame says it is happening at this moment.
    const own = text
      .split('\n')
      .filter(
        (line) =>
          line.startsWith('Selected source') ||
          line.startsWith('This is recorded') ||
          line.startsWith('Capture time'),
      );
    for (const word of [' live', ' now', 'fresh', 'current', 'in your room', ' here'])
      assert.equal(own.join(' ').toLowerCase().includes(word), false, word);
  }
  const photo = userText({
    ...input,
    sourceContext: {
      source: 'past-recollection',
      capturedAt: null,
      timestampTrusted: false,
      selectionReason: 'Inspect the selected recorded frame.',
      recorded: { seconds: null },
    },
  });
  assert.ok(photo.includes("Selected source: the person's own recorded photo."));
});
