/**
 * Journals written by earlier activity code must keep replaying, and a submission exported before
 * an upgrade must never turn into a 500 when the person exports it again. The rows below were
 * journaled by the batch-1 store (before the U10 instruction change) from synthetic input.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ActivityStore } from '../activity.ts';
import { sha256 } from '../activity-contract.ts';
import { BoopyError } from '../boopy.ts';
import type { BoopyEvent } from '../events.ts';
import { Journal } from '../journal.ts';

const LEGACY = {
  activityId: 'act_legacy2',
  first: 'sub_legacy3',
  second: 'sub_legacy4',
  exportSha256: 'c8f24d8aa73f17e86ba18aff7054f14ebf221b02d3d7b3da9b2b035f1232538b',
  rows: [
    {
      id: 'evt_f7675ce3-4421-4c0b-bf2e-fb06842c941b',
      type: 'activity.request-prepared',
      session: 'session_legacy',
      actor: 'person',
      at: '1970-01-01T09:01:00.000Z',
      data: {
        requestId: 'arq_legacy1',
        packageId: 'ctx_legacy1',
        preparation: {
          requestId: 'legacy-preparation-1',
          receiptId: 'receipt_legacy',
          packetSha256: '691c1561b060ab2fd5cab141fb6629203ce6b2afe51ad75c6cd758a103422541',
        },
        goal: 'Synthetic goal.',
        personLanguage: 'en',
        background: null,
        sources: [],
        fileSha256: '75f173278654fab0724f0daee952385d5a754a4d2d3c2cfdff1a455f763dc91f',
        delivery: 'not-sent',
      },
    },
    {
      id: 'evt_925c694f-5885-4bc1-8cd2-7f2bce92e7f6',
      type: 'activity.imported',
      session: 'session_legacy',
      actor: 'person',
      at: '1970-01-01T09:02:00.000Z',
      data: {
        activityId: 'act_legacy2',
        requestId: 'arq_legacy1',
        artifactSha256: 'b12f2c637a366202819841e07c0c68527bf82b08e5aa033122dddaba002faf39',
        container: 'json',
        claimedAuthor: null,
        fallbackText: 'Synthetic fallback.',
        activity: {
          title: 'Camel and tent',
          purpose: 'Synthetic upgrade check.',
          instruction: {
            text: 'Place them, then build the sentence.',
            language: 'en',
          },
          components: [
            {
              type: 'arrange',
              axis: {
                kind: 'viewer-left-right',
              },
              tokens: [
                {
                  key: 'a',
                  label: {
                    text: 'camel',
                    language: 'en',
                  },
                  sourceId: null,
                },
                {
                  key: 'b',
                  label: {
                    text: 'tent',
                    language: 'en',
                  },
                  sourceId: null,
                },
              ],
              target: {
                subject: 'a',
                relation: 'left-of',
                object: 'b',
              },
            },
            {
              type: 'sequence',
              joiner: 'space',
              language: 'en',
              tiles: [
                {
                  key: 't1',
                  text: 'camel',
                },
                {
                  key: 't2',
                  text: 'left',
                },
                {
                  key: 't3',
                  text: 'tent',
                },
              ],
            },
          ],
          hints: [
            {
              text: 'Start with the camel.',
              language: 'en',
            },
            {
              text: 'Say where it is.',
              language: 'en',
            },
          ],
        },
        issues: [],
        parent: null,
      },
    },
    {
      id: 'evt_448db9bc-fac5-4814-a142-996161ea3338',
      type: 'activity.arranged',
      session: 'session_legacy',
      actor: 'person',
      at: '1970-01-01T09:03:00.000Z',
      data: {
        activityId: 'act_legacy2',
        revision: 1,
        positions: {
          a: 0.2,
          b: 0.7,
        },
      },
    },
    {
      id: 'evt_eedd0779-c1e7-428a-b05e-1d9f9147e6b3',
      type: 'activity.sequenced',
      session: 'session_legacy',
      actor: 'person',
      at: '1970-01-01T09:04:00.000Z',
      data: {
        activityId: 'act_legacy2',
        revision: 2,
        chosen: ['t1', 't2', 't3'],
      },
    },
    {
      id: 'evt_68b27f88-26da-4156-b779-f90c52a944da',
      type: 'activity.hint-revealed',
      session: 'session_legacy',
      actor: 'person',
      at: '1970-01-01T09:05:00.000Z',
      data: {
        activityId: 'act_legacy2',
        revision: 3,
        index: 0,
      },
    },
    {
      id: 'evt_01b3b48f-397d-4069-a3f7-9979884463c2',
      type: 'activity.submitted',
      session: 'session_legacy',
      actor: 'person',
      at: '1970-01-01T09:06:00.000Z',
      data: {
        activityId: 'act_legacy2',
        revision: 4,
        submissionId: 'sub_legacy3',
        positions: {
          a: 0.2,
          b: 0.7,
        },
        derived: {
          relation: 'left-of',
          matchesTarget: true,
          order: ['a', 'b'],
          ties: false,
          values: null,
        },
        chosen: ['t1', 't2', 't3'],
        text: 'camel left tent',
        hintsRevealed: [0],
        digest:
          'arrange: camel left of tent (your view); requested camel left of tent; arrangement matches | sequence: "camel left tent" | hints: 1 of 2',
      },
    },
    {
      id: 'evt_92cf1855-59aa-4020-904e-3270c565bd01',
      type: 'activity.submission-exported',
      session: 'session_legacy',
      actor: 'person',
      at: '1970-01-01T09:07:00.000Z',
      data: {
        submissionId: 'sub_legacy3',
        activityId: 'act_legacy2',
        fileSha256: 'c8f24d8aa73f17e86ba18aff7054f14ebf221b02d3d7b3da9b2b035f1232538b',
        delivery: 'not-sent',
      },
    },
    {
      id: 'evt_0ceea19e-5972-424b-98cf-4d4bca6a39b0',
      type: 'activity.hint-revealed',
      session: 'session_legacy',
      actor: 'person',
      at: '1970-01-01T09:08:00.000Z',
      data: {
        activityId: 'act_legacy2',
        revision: 5,
        index: 1,
      },
    },
    {
      id: 'evt_2f27348d-2fb7-4af3-b653-66a16d6552e0',
      type: 'activity.submitted',
      session: 'session_legacy',
      actor: 'person',
      at: '1970-01-01T09:09:00.000Z',
      data: {
        activityId: 'act_legacy2',
        revision: 6,
        submissionId: 'sub_legacy4',
        positions: {
          a: 0.2,
          b: 0.7,
        },
        derived: {
          relation: 'left-of',
          matchesTarget: true,
          order: ['a', 'b'],
          ties: false,
          values: null,
        },
        chosen: ['t1', 't2', 't3'],
        text: 'camel left tent',
        hintsRevealed: [0, 1],
        digest:
          'arrange: camel left of tent (your view); requested camel left of tent; arrangement matches | sequence: "camel left tent" | hints: 2 of 2',
      },
    },
  ],
};

function replayed() {
  const journal = Journal.open(':memory:');
  for (const row of LEGACY.rows)
    journal.append(
      {
        type: row.type,
        session: row.session,
        actor: row.actor,
        data: row.data,
      } as unknown as BoopyEvent,
      row.id,
      row.at,
    );
  return { journal, store: new ActivityStore({ journal }) };
}

test('audit upgrade: a journal written by batch-1 code replays with both submissions', () => {
  const { journal, store } = replayed();
  try {
    assert.equal(journal.all().length, LEGACY.rows.length, 'startup appended events');
    const view = store.view(LEGACY.activityId);
    assert.deepEqual(
      view.submissions.map((submission) => submission.submissionId),
      [LEGACY.first, LEGACY.second],
    );
    assert.equal(view.submissions[0]?.export?.fileSha256, LEGACY.exportSha256);
    assert.equal(view.submissions[1]?.export, null);
    assert.deepEqual(view.submissions[0]?.hintsRevealed, [0]);
    assert.deepEqual(view.submissions[1]?.hintsRevealed, [0, 1]);
  } finally {
    journal.close();
  }
});

test('audit upgrade: exporting a submission again after an upgrade never fails with a 500', () => {
  const { journal, store } = replayed();
  try {
    for (const submissionId of [LEGACY.first, LEGACY.second]) {
      let exported: { file: string; fileSha256: string } | null = null;
      try {
        exported = store.exportSubmission(submissionId);
      } catch (error) {
        // A clear refusal is acceptable; a generic error is a 500 on the connector.
        assert.ok(
          error instanceof BoopyError && error.status < 500,
          `${submissionId}: ${String(error)}`,
        );
      }
      if (exported === null) continue;
      assert.equal(sha256(exported.file), exported.fileSha256);
      const recorded = store
        .view(LEGACY.activityId)
        .submissions.find((submission) => submission.submissionId === submissionId);
      assert.equal(recorded?.export?.fileSha256, exported.fileSha256, 'view and bytes disagree');
    }
  } finally {
    journal.close();
  }
});
