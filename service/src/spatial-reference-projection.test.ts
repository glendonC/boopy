import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { Recorded } from './journal.ts';
import { Projection } from './session.ts';
import { startRequest, testBoopy } from './testing.ts';

it('replay rejects model-authored and ordinary-note focus events without changing the referent', async () => {
  const test = testBoopy();
  try {
    await test.boopy.start(startRequest('Inspect this synthetic display.'));
    const started = test.journal.all().find((event) => event.type === 'session.started');
    assert.ok(started);
    const initial = test.boopy.view(started.session);
    const target = initial.items.find((item) => item.id !== initial.referentId);
    assert.ok(target);
    await test.boopy.utter(started.session, {
      speech: { text: 'A synthetic personal note.' },
      cues: { targetItemId: target.id },
    });
    const noteEvents = test.journal.all();
    const note = noteEvents.find(
      (event) => event.type === 'utterance.heard' && event.data.reading.kind === 'note',
    );
    assert.ok(note?.type === 'utterance.heard');
    const malformedNote: Recorded = {
      type: 'interaction.focused',
      actor: 'person',
      session: started.session,
      data: { utteranceId: note.data.utteranceId, itemId: target.id },
      seq: noteEvents.length + 1,
      id: 'synthetic-malformed-note-focus',
      at: started.at,
    };
    const noteProjection = Projection.from(noteEvents);
    const priorReferent = noteProjection.session(started.session)?.referentId;
    assert.throws(() => noteProjection.apply(malformedNote), /Invalid spatial reference/);
    assert.equal(noteProjection.session(started.session)?.referentId, priorReferent);
    await test.boopy.utter(started.session, {
      speech: { text: 'I mean this one' },
      cues: { targetItemId: target.id },
    });
    const events = test.journal.all();
    const focusIndex = events.findIndex((event) => event.type === 'interaction.focused');
    const focus = events[focusIndex];
    assert.ok(focus?.type === 'interaction.focused');
    const modelProjection = Projection.from(events.slice(0, focusIndex));
    const beforeModelFocus = modelProjection.session(started.session)?.referentId;
    assert.throws(
      () => modelProjection.apply({ ...focus, actor: 'model:synthetic' }),
      /Invalid spatial reference/,
    );
    assert.equal(modelProjection.session(started.session)?.referentId, beforeModelFocus);
    const replayed = Projection.from(events).session(started.session);
    assert.equal(replayed?.referentId, target.id);
    assert.equal(replayed?.items.find((item) => item.id === target.id)?.status, 'proposed');
  } finally {
    test.journal.close();
  }
});
