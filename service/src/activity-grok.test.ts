/** Real Grok Bot files from the first round trip (synthetic scene), kept byte-exact as fixtures. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ActivityStore } from './activity.ts';
import {
  readActivityFile,
  readReplyFile,
  sha256,
  validateActivityBody,
} from './activity-contract.ts';
import { Journal } from './journal.ts';
import { startRequest, testBoopy } from './testing.ts';

const FOLDER = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'activity', 'grok');
const read = (name: string) => readFileSync(join(FOLDER, name), 'utf8');
const ACTIVITY = 'boopy-desert-camp.json';
const REPLY_1 = 'boopy-reply-1.json';
const REPLY_2 = 'boopy-reply-2.json';
const CAMELS = 'ctx_mvazxf42cm2el2:int_mvazxf3siuvntq.camels';
const TENTS = 'ctx_mvazxf42cm2el2:int_mvazxf3siuvntq.tents';
/** The sources the files name; the real request listed both among its allowed sources. */
const SOURCES = new Set([CAMELS, TENTS]);
const PACKET = '9c21d882c49d0ef9e47728f481234dbf0bb16fcb6625134ff7f60ed1aa5f9c54';

describe('real Grok Bot files', () => {
  it('are the exact bytes Grok wrote', () => {
    assert.deepEqual(
      [ACTIVITY, REPLY_1, REPLY_2].map((name) => sha256(read(name))),
      [
        '478ae3e361d520b5bc49c911452787a2943c256ec3bcb21c71248fa3fd3bc930',
        '351b96dcd37cd69ad9cfced090867cb3183d85eb779dcd8f8c63b14696a19f1d',
        '1fdf032424d5d3f3a6cd7674ef09b2d120248cf1771ad581109888b9de5c97ee',
      ],
    );
  });

  it('pass envelope and body validation', () => {
    const activity = readActivityFile(read(ACTIVITY));
    assert.equal(activity.kind, 'read');
    if (activity.kind !== 'read') return;
    assert.equal(activity.container, 'json');
    assert.equal(activity.file.author, 'Grok Bot');
    assert.deepEqual(activity.file.binding, {
      requestId: 'arq_yqUSl_PlLXbzQx_o',
      packageId: 'ctx_mvazxf42cm2el2',
      packetSha256: PACKET,
    });
    assert.deepEqual(validateActivityBody(activity.file.activity, SOURCES).issues, []);
    for (const name of [REPLY_1, REPLY_2]) {
      const reply = readReplyFile(read(name));
      assert.equal(reply.kind, 'read', name);
      if (reply.kind !== 'read') continue;
      assert.equal(reply.file.author, 'Grok Bot');
      assert.ok(reply.file.next, name);
      assert.deepEqual(
        validateActivityBody(reply.file.next.activity, SOURCES, ['next', 'activity']).issues,
        [],
        name,
      );
    }
  });

  it('replay the round trip through the store, each echo matching the digest Boopy computes', async () => {
    const journal = Journal.open(':memory:');
    const test = testBoopy({ journal });
    const session = (await test.boopy.start(startRequest('Synthetic desert camp.'))).id;
    journal.append(
      {
        type: 'activity.request-prepared',
        session,
        actor: 'person',
        data: {
          requestId: 'arq_yqUSl_PlLXbzQx_o',
          packageId: 'ctx_mvazxf42cm2el2',
          preparation: { requestId: 'synthetic', receiptId: 'handoff_x', packetSha256: PACKET },
          goal: 'Practice saying where things are in Korean, using my desert camp.',
          personLanguage: 'en',
          background: null,
          sources: [
            { sourceId: CAMELS, label: 'Camels', gloss: '낙타', verification: 'accepted' },
            { sourceId: TENTS, label: 'Tents', gloss: '텐트', verification: 'accepted' },
          ],
          fileSha256: '3c1c3ebe567c48cf970a1ed84899e021b289585fda17cae4134cdd302adba22d',
          delivery: 'not-sent',
        },
      },
      'evt_grok_request',
      '1970-01-01T09:49:00.000Z',
    );
    // The identifiers Boopy gave in the real run, so the replies' bindings resolve.
    const ids: Record<string, string[]> = {
      act: ['act_ONgZ-Wk6WCsN6Erk', 'act_o8_J1ieTzKvR-TmI', 'act_3djZ_GPtJ_UxU4IP'],
      sub: ['sub_3qhcYCq4Dz2ZHDrc', 'sub_5cmCv1f0eMARYN-P'],
      rep: ['rep_Ko-inGfuqelpScWl', 'rep_DLoZzZAVvIj2TBw8'],
    };
    const store = new ActivityStore({
      journal,
      newId: (prefix) => ids[prefix]?.shift() ?? `${prefix}_unexpected`,
    });
    const imported = store.importActivity(read(ACTIVITY));
    assert.deepEqual(imported, {
      activityId: 'act_ONgZ-Wk6WCsN6Erk',
      status: 'active',
      issues: [],
      duplicate: false,
    });
    const id = imported.activityId;

    // Attempt 1: camels right of the tents where left was requested, two of three hints.
    store.arrange(id, { revision: 0, positions: { a: 0.8, b: 0.2 } });
    store.revealHint(id, { revision: 1 });
    store.revealHint(id, { revision: 2 });
    const first = store.submit(id, { revision: 3 }).submissions[0];
    assert.equal(
      first?.digest,
      'arrange: 낙타 right of 텐트 (your view); requested 낙타 left of 텐트; arrangement does not match | hints: 2 of 3',
    );
    store.exportSubmission('sub_3qhcYCq4Dz2ZHDrc');
    assert.deepEqual(store.importReply(read(REPLY_1)), {
      replyId: 'rep_Ko-inGfuqelpScWl',
      submissionId: 'sub_3qhcYCq4Dz2ZHDrc',
      activityId: id,
      nextActivityId: 'act_o8_J1ieTzKvR-TmI',
      nextStatus: 'active',
      duplicate: false,
    });

    // Attempt 2: camels left of the tents, matching, with the same two hints still open.
    store.arrange(id, { revision: 4, positions: { a: 0.2, b: 0.8 } });
    const second = store.submit(id, { revision: 5 }).submissions[1];
    assert.equal(
      second?.digest,
      'arrange: 낙타 left of 텐트 (your view); requested 낙타 left of 텐트; arrangement matches | hints: 2 of 3',
    );
    store.exportSubmission('sub_5cmCv1f0eMARYN-P');
    assert.deepEqual(store.importReply(read(REPLY_2)), {
      replyId: 'rep_DLoZzZAVvIj2TBw8',
      submissionId: 'sub_5cmCv1f0eMARYN-P',
      activityId: id,
      nextActivityId: 'act_3djZ_GPtJ_UxU4IP',
      nextStatus: 'active',
      duplicate: false,
    });
    const next = store.view('act_3djZ_GPtJ_UxU4IP');
    assert.equal(next.title, 'Tents on the right');
    assert.deepEqual(next.provenance.parent, {
      activityId: id,
      submissionId: 'sub_5cmCv1f0eMARYN-P',
      replyId: 'rep_DLoZzZAVvIj2TBw8',
    });
    assert.equal(next.provenance.artifactSha256, sha256(read(REPLY_2)));
    journal.close();
  });
});
