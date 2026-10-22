import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { BoopyEvent } from './events.ts';
import { Journal } from './journal.ts';

const AT = '1970-01-01T00:00:00.000Z';

const started = (session: string): BoopyEvent => ({
  type: 'session.started',
  session,
  actor: 'person',
  data: { device: null },
});

const speech = (session: string): BoopyEvent => ({
  type: 'speech.requested',
  session,
  actor: 'person',
  data: { attemptId: 'spk_1', utteranceId: 'utt_1', responseAt: AT },
});

const ids = (journal: Journal) => journal.all().map((event) => event.id);

describe('journal', () => {
  it('a transaction keeps every append in it or none of them', () => {
    const journal = Journal.open(':memory:');
    const kept = journal.transaction(() => {
      journal.append(started('ses_a'), 'evt_a', AT);
      journal.append(started('ses_b'), 'evt_b', AT);
      return 'kept';
    });
    assert.equal(kept, 'kept');
    assert.deepEqual(ids(journal), ['evt_a', 'evt_b']);
    assert.throws(
      () =>
        journal.transaction(() => {
          journal.append(started('ses_c'), 'evt_c', AT);
          throw new Error('Synthetic failure.');
        }),
      /Synthetic failure/,
    );
    assert.throws(
      () =>
        journal.transaction(() => {
          journal.append(started('ses_d'), 'evt_d', AT);
          journal.append(started('ses_e'), 'evt_a', AT);
        }),
      /UNIQUE/,
    );
    assert.throws(
      () =>
        journal.transaction(() => {
          journal.append(started('ses_f'), 'evt_f', AT);
          return Promise.resolve();
        }),
      /synchronous/,
    );
    assert.deepEqual(ids(journal), ['evt_a', 'evt_b']);
    journal.transaction(() => journal.append(started('ses_g'), 'evt_g', AT));
    assert.deepEqual(ids(journal), ['evt_a', 'evt_b', 'evt_g']);
  });

  it('knows which ids it holds and reads one type prefix in order', () => {
    const journal = Journal.open(':memory:');
    journal.append(started('ses_a'), 'evt_a', AT);
    journal.append(speech('ses_a'), 'evt_speech', AT);
    journal.append(started('ses_b'), 'evt_b', AT);
    assert.equal(journal.has('evt_speech'), true);
    assert.equal(journal.has('evt_missing'), false);
    const sessions = journal.withTypePrefix('session.');
    assert.deepEqual(
      sessions.map((event) => [event.id, event.type, event.session]),
      [
        ['evt_a', 'session.started', 'ses_a'],
        ['evt_b', 'session.started', 'ses_b'],
      ],
    );
    assert.deepEqual(
      sessions,
      journal.all().filter((event) => event.type === 'session.started'),
    );
    assert.deepEqual(journal.withTypePrefix('SESSION.'), []);
    assert.deepEqual(journal.withTypePrefix('s%'), []);
    assert.deepEqual(journal.withTypePrefix('sp'), [journal.all()[1]]);
  });
});
