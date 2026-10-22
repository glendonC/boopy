import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Boopy, BoopyError } from './boopy.ts';
import type { SessionView } from './contracts.ts';
import type { Interpreter } from './interpret/interpreter.ts';
import { frameOf, startRequest, testBoopy } from './testing.ts';

const item = (view: SessionView, label: string) => {
  const found = view.items.find((candidate) => candidate.label === label);
  assert.ok(found, `no item "${label}" in ${view.items.map((i) => i.label).join(', ')}`);
  return found;
};

it('keeps exact authored Add text through journal replay and committed packaging', async () => {
  const { boopy, deps, journal } = testBoopy();
  const initial = await boopy.start(startRequest('Describe this synthetic picture.'));
  const words = 'iPhone  사진 — Saya’s Trip!';
  const updated = await boopy.utter(initial.id, { speech: { text: `ADD ${words}` } });
  const authored = updated.items.find((candidate) => candidate.origin === 'person');
  assert.ok(authored);
  assert.equal(authored.statement, words);
  assert.equal(authored.status, 'confirmed');
  assert.equal(authored.confidence, null);
  const restored = new Boopy(deps);
  await restored.utter(initial.id, { speech: { text: 'Save it' } });
  const committed = journal.all().findLast((event) => event.type === 'context.committed');
  assert.ok(committed && committed.type === 'context.committed');
  const packaged = committed.data.package.items.find((candidate) => candidate.id === authored.id);
  assert.equal(packaged?.statement, words);
  assert.equal(packaged?.verification, 'authored');
});

describe('a session from question to commit', async () => {
  const { boopy, deps, journal } = testBoopy();
  const said = 'I want to practice talking about this trip in Korean.';
  let view = await boopy.start(startRequest(said));
  const sessionId = view.id;

  it('proposes an interpretation with an intent, a referent and open questions', () => {
    assert.equal(view.state, 'review');
    assert.equal(item(view, 'Talk about the trip').id, view.intentId);
    assert.equal(item(view, 'Desert photo').id, view.referentId);
    assert.equal(item(view, 'Where was this trip?').kind, 'question');
    assert.ok(view.items.every((i) => i.status === 'proposed' && i.origin === 'model'));
    assert.equal(view.model?.provider, 'fixture');
    assert.equal(
      view.notice,
      "I couldn't tell what you meant from this view. Point at one thing and ask again.",
    );
  });

  it('confirms a card on a pinch', () => {
    view = boopy.act(sessionId, { itemId: item(view, 'Past tense').id, action: 'confirm' });
    assert.equal(item(view, 'Past tense').status, 'confirmed');
    assert.equal(view.notice, 'Confirmed "Past tense".');
  });

  it('rejects the card under the ray, keeping the reason', async () => {
    view = await boopy.utter(sessionId, {
      speech: { text: "Not that, we didn't camp" },
      cues: { targetItemId: item(view, 'Tents').id },
    });
    assert.equal(item(view, 'Tents').status, 'rejected');
    assert.equal(item(view, 'Tents').note, "we didn't camp");
  });

  it('finds the card by name when nothing is targeted', async () => {
    view = await boopy.utter(sessionId, { speech: { text: 'I already know desert' } });
    assert.equal(item(view, 'desert').status, 'known');
  });

  it('asks which card when the words name none', async () => {
    view = await boopy.utter(sessionId, { speech: { text: 'I already know this' } });
    assert.equal(view.notice, 'Which one? Point at a card and say it again.');
  });

  it('marks what matters, renames, and adds what the person says', async () => {
    view = await boopy.utter(sessionId, {
      speech: { text: 'This matters' },
      cues: { targetItemId: item(view, 'Camels').id },
    });
    assert.equal(item(view, 'Camels').emphasis, true);
    view = await boopy.utter(sessionId, {
      speech: { text: "It's a dromedary" },
      cues: { targetItemId: item(view, 'Camels').id },
    });
    assert.equal(item(view, 'dromedary').proposedLabel, 'Camels');
    view = await boopy.utter(sessionId, {
      speech: { text: 'I also want to talk about the sunset' },
    });
    const added = item(view, 'talk about the sunset');
    assert.equal(added.origin, 'person');
    assert.equal(added.status, 'confirmed');
  });

  it('widens to the whole scene and keeps everything the person touched', async () => {
    view = await boopy.utter(sessionId, { speech: { text: 'Use the whole scene' } });
    assert.equal(view.scope, 'scene');
    assert.equal(view.referentId, null);
    assert.equal(item(view, 'Tents').status, 'rejected');
    assert.equal(item(view, 'desert').status, 'known');
    assert.equal(item(view, 'Past tense').status, 'confirmed');
    assert.equal(item(view, 'dromedary').emphasis, true);
    const labels = view.items.map((i) => i.label.toLowerCase());
    assert.equal(new Set(labels).size, labels.length, 'no repeated cards');
    assert.equal(view.model !== null && view.utterances.length > 0, true);
  });

  it('commits a package that separates the person from the model', async () => {
    view = await boopy.utter(sessionId, { speech: { text: 'Save it' } });
    assert.equal(view.state, 'committed');
    const pkg = boopy.package(view.committed?.packageId ?? '');
    assert.ok(pkg);
    const verification = (label: string) => pkg.items.find((i) => i.label === label)?.verification;
    assert.equal(verification('Past tense'), 'confirmed');
    assert.equal(verification('dromedary'), 'corrected');
    assert.equal(verification('talk about the sunset'), 'authored');
    assert.equal(verification('Describing the landscape'), 'accepted');
    assert.deepEqual(
      pkg.rejected.map((r) => [r.label, r.reason]),
      [['Tents', "we didn't camp"]],
    );
    assert.deepEqual(
      pkg.known.map((k) => k.label),
      ['desert'],
    );
    assert.equal(pkg.intent?.said, said);
    assert.equal(pkg.provenance.device, 'Meta Quest 3');
    assert.equal(pkg.provenance.models.length, 2);
    assert.match(pkg.text, /Rejected by the person: Tents \(we didn't camp\)/);
    assert.match(pkg.text, /Already known by the person: desert \(사막\)/);
    assert.match(pkg.text, /\[corrected by the person, the person said this matters\] dromedary/);
  });

  it('refuses more words once the session is saved', async () => {
    await assert.rejects(
      boopy.utter(sessionId, { speech: { text: 'yes' } }),
      (error: unknown) => error instanceof BoopyError && error.code === 'committed',
    );
  });

  it('rebuilds the same state from the journal alone', () => {
    const replayed = new Boopy({ ...deps, journal });
    const again = replayed.view(sessionId);
    assert.deepEqual({ ...again, notice: null }, { ...boopy.view(sessionId), notice: null });
    assert.deepEqual(replayed.packages(), boopy.packages());
  });
});

describe('speech and failures', () => {
  it('does not infer item review or confirmation from a direct save, with or without a headset', async () => {
    for (const hasHeadset of [false, true]) {
      const { boopy, journal } = testBoopy();
      const request = startRequest('Help me describe this trip.');
      if (!hasHeadset) delete request.device;
      const view = await boopy.start(request);
      const saved = boopy.commit(view.id);
      const pkg = boopy.package(saved.committed?.packageId ?? '');
      assert.ok(pkg);
      assert.ok(pkg.items.length > 0);
      assert.ok(pkg.items.every((item) => item.verification === 'accepted'));
      assert.equal(pkg.intent?.verification, 'accepted');
      assert.equal(pkg.provenance.corrections, 0);
      assert.ok(!journal.all().some((event) => event.type === 'item.corrected'));
      assert.doesNotMatch(pkg.text, /The person reviewed this in the headset/);
      assert.doesNotMatch(pkg.text, /\[confirmed\]|Intent \(confirmed\)/);
      assert.match(pkg.text, /not individually confirmed/);
      assert.match(pkg.text, /does not establish that every item was reviewed/);
      assert.match(pkg.text, /\[accepted, model confidence/);
      if (!hasHeadset) {
        assert.equal(pkg.provenance.device, null);
        assert.match(pkg.text, /from an unspecified device/);
        assert.doesNotMatch(pkg.text, /from a headset/);
      }
    }
  });

  it('transcribes a clip and records the detected language', async () => {
    const { boopy, speech } = testBoopy();
    speech.heard = { text: '이게 뭐예요?', language: 'ko' };
    const view = await boopy.start({
      frame: frameOf(),
      cues: {},
      speech: { wav: Buffer.from('RIFF....WAVE').toString('base64') },
    });
    assert.deepEqual(view.utterances[0], {
      id: view.utterances[0]?.id,
      text: '이게 뭐예요?',
      language: 'ko',
      kind: 'ask',
    });
  });

  it('keeps the session open and says why when the model fails', async () => {
    const failing: Interpreter = {
      provider: 'test',
      model: 'broken',
      interpret: async () => {
        throw new Error('model unavailable');
      },
    };
    const { boopy, journal } = testBoopy({ interpreter: failing });
    const view = await boopy.start(startRequest('What is this?'));
    assert.equal(view.state, 'review');
    assert.equal(view.items.length, 0);
    assert.equal(view.notice, 'Could not interpret that. Please try again.');
    assert.ok(journal.all().some((event) => event.type === 'interpretation.failed'));
  });

  it('refuses a frame that is not a JPEG', async () => {
    const { boopy } = testBoopy();
    await assert.rejects(
      boopy.start({ ...startRequest('hi'), frame: { ...frameOf(), jpeg: 'aGVsbG8=' } }),
      (error: unknown) => error instanceof BoopyError && error.code === 'invalid_frame',
    );
  });
});
