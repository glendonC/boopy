import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Boopy, BoopyError } from './boopy.ts';
import { StartSessionRequest } from './contracts.ts';
import { connectorApp } from './http/connector.ts';
import { headsetApp } from './http/headset.ts';
import { FixtureInterpreter } from './interpret/fixture.ts';
import { Journal } from './journal.ts';
import { startRequest, testBoopy } from './testing.ts';

const requestId = 'b3ccdf43-6c48-429e-9214-8d30c822d201';
const matchesCode = (code: string) => (error: unknown) =>
  error instanceof BoopyError && error.status === 409 && error.code === code;

describe('durable keyed first-session recovery', () => {
  it('one active request creates one session and rejects pending/conflicting duplicates without rerunning perception', async () => {
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const fixture = new FixtureInterpreter();
    const { boopy, journal } = testBoopy({
      interpreter: {
        provider: 'fixture',
        model: 'synthetic-barrier',
        async interpret(input) {
          calls++;
          entered();
          await gate;
          return fixture.interpret(input);
        },
      },
    });
    const request = StartSessionRequest.parse({
      ...startRequest('Synthetic keyed capture.'),
      requestId,
    });
    const first = boopy.start(request);
    try {
      await Promise.race([
        started,
        first.then(() => {
          throw new Error('Start completed before the synthetic barrier.');
        }),
      ]);
      assert.equal(boopy.startStatus(requestId).status, 'pending');
      await assert.rejects(boopy.start(request), matchesCode('start_pending'));
      await assert.rejects(
        boopy.start({ ...request, speech: { text: 'Different synthetic capture.' } }),
        matchesCode('start_conflict'),
      );
      assert.equal(journal.all().filter((event) => event.type === 'session.started').length, 1);
      assert.equal(
        journal.all().filter((event) => event.type === 'observation.recorded').length,
        1,
      );
      assert.equal(journal.all().filter((event) => event.type === 'utterance.heard').length, 1);
      release();
      const view = await first;
      assert.equal(boopy.startStatus(requestId).sessionId, view.id);
      assert.equal(boopy.startStatus(requestId).status, 'succeeded');
      assert.equal(calls, 1);
      const event = journal.all().find((record) => record.type === 'session.started');
      assert.ok(event?.type === 'session.started' && event.data.startRequest);
      assert.match(event.data.startRequest.requestSha256, /^[a-f0-9]{64}$/);
      assert.doesNotMatch(
        JSON.stringify(event.data.startRequest),
        /Synthetic keyed|jpeg|wav|speech/,
      );
    } finally {
      release();
      await first.catch(() => {});
      journal.close();
    }
  });

  it('schema defaults and key ordering compare equally; replay returns current corrections and committed receipt', async () => {
    const { boopy, deps, journal } = testBoopy();
    try {
      const input = {
        ...startRequest('Synthetic defaulted request.'),
        requestId,
        attention: { source: 'current-surroundings', scope: 'scene', evidence: 'visual' },
      };
      input.frame = { ...input.frame, source: 'current-surroundings', timestampTrusted: false };
      const request = StartSessionRequest.parse(input);
      const view = await boopy.start(request);
      const target = view.items.find((item) => item.kind === 'object');
      assert.ok(target);
      boopy.act(view.id, { itemId: target.id, action: 'confirm' });
      const before = journal.all().length;
      const reordered = StartSessionRequest.parse({
        speech: input.speech,
        attention: {
          maxAgeMs: 15000,
          segmentationRequested: false,
          ocrRequested: false,
          ambiguousTarget: false,
          evidence: 'visual',
          scope: 'scene',
          source: 'current-surroundings',
        },
        cues: input.cues,
        device: input.device,
        requestId,
        frame: {
          capturedAt: input.frame.capturedAt,
          height: input.frame.height,
          width: input.frame.width,
          jpeg: input.frame.jpeg,
          timestampTrusted: false,
          source: 'current-surroundings',
        },
      });
      const replay = await new Boopy(deps).start(reordered);
      assert.equal(replay.id, view.id);
      assert.equal(replay.items.find((item) => item.id === target.id)?.status, 'confirmed');
      assert.equal(journal.all().length, before);
      const committed = boopy.commit(view.id);
      const afterCommit = journal.all().length;
      assert.deepEqual(await new Boopy(deps).start(request), new Boopy(deps).view(committed.id));
      assert.equal(journal.all().length, afterCommit);
    } finally {
      journal.close();
    }
  });

  it('nested camera/cue key ordering is normalized while array order remains part of identity', async () => {
    const { boopy, journal } = testBoopy();
    try {
      const input = {
        ...startRequest('Synthetic nested payload.'),
        requestId,
        frame: {
          ...startRequest('Synthetic').frame,
          camera: {
            eye: 'left',
            pose: { position: [0, 1, 2], rotation: [0, 0, 0, 1] },
            focalLength: [1000, 1000],
            principalPoint: [640, 480],
            sensorResolution: [1280, 960],
          },
        },
        cues: { gaze: { point: { x: 0.4, y: 0.5 }, world: [0, 1, 2], onSurface: true } },
        attention: { source: 'unknown', scope: 'scene', evidence: 'none' },
      };
      const request = StartSessionRequest.parse(input);
      const first = await boopy.start(request);
      const reordered = StartSessionRequest.parse({
        ...input,
        frame: {
          ...input.frame,
          camera: {
            sensorResolution: [1280, 960],
            principalPoint: [640, 480],
            focalLength: [1000, 1000],
            pose: { rotation: [0, 0, 0, 1], position: [0, 1, 2] },
            eye: 'left',
          },
        },
        cues: { gaze: { onSurface: true, world: [0, 1, 2], point: { y: 0.5, x: 0.4 } } },
      });
      const count = journal.all().length;
      assert.equal((await boopy.start(reordered)).id, first.id);
      assert.equal(journal.all().length, count);
      const changed = StartSessionRequest.parse({
        ...input,
        cues: { gaze: { ...input.cues.gaze, world: [2, 1, 0] } },
      });
      await assert.rejects(boopy.start(changed), matchesCode('start_conflict'));
      assert.equal(journal.all().length, count);
    } finally {
      journal.close();
    }
  });

  it('failed starts keep terminal sanitized failure and never retry observation or speech', async () => {
    const { boopy, deps, journal } = testBoopy();
    try {
      const request = StartSessionRequest.parse({
        ...startRequest('Synthetic failure.'),
        requestId,
        frame: { ...startRequest('Synthetic').frame, jpeg: 'not-a-jpeg' },
      });
      await assert.rejects(
        boopy.start(request),
        (error) => error instanceof BoopyError && error.code === 'invalid_frame',
      );
      const status = boopy.startStatus(requestId);
      assert.equal(status.status, 'failed');
      assert.equal(status.failureCode, 'invalid_frame');
      assert.equal(status.view, null);
      const count = journal.all().length;
      await assert.rejects(boopy.start(request), matchesCode('start_failed'));
      await assert.rejects(new Boopy(deps).start(request), matchesCode('start_failed'));
      assert.equal(journal.all().length, count);
      assert.equal(
        journal.all().filter((event) => event.type === 'observation.recorded').length,
        0,
      );
      assert.equal(journal.all().filter((event) => event.type === 'utterance.heard').length, 0);
    } finally {
      journal.close();
    }
  });

  it('speech failure is durable and retry cannot retranscribe or duplicate frame retention', async () => {
    const { boopy, deps, journal, speech } = testBoopy();
    let calls = 0;
    speech.transcribe = async () => {
      calls++;
      throw new Error('synthetic-private-transcription-detail');
    };
    try {
      const request = StartSessionRequest.parse({
        ...startRequest('Synthetic'),
        requestId,
        speech: { wav: Buffer.from('synthetic-audio').toString('base64') },
      });
      await assert.rejects(
        boopy.start(request),
        (error) => error instanceof BoopyError && error.code === 'speech_failed',
      );
      const status = new Boopy(deps).startStatus(requestId);
      assert.equal(status.status, 'failed');
      assert.equal(status.failureCode, 'speech_failed');
      assert.equal(status.view, null);
      const count = journal.all().length;
      await assert.rejects(new Boopy(deps).start(request), matchesCode('start_failed'));
      assert.equal(calls, 1);
      assert.equal(journal.all().length, count);
      assert.equal(
        journal.all().filter((event) => event.type === 'observation.recorded').length,
        1,
      );
      assert.equal(journal.all().filter((event) => event.type === 'utterance.heard').length, 0);
      const finished = journal.all().filter((event) => event.type === 'session.start.finished');
      assert.equal(finished.length, 1);
      assert.doesNotMatch(
        JSON.stringify(finished),
        /synthetic-private-transcription-detail|synthetic-audio/,
      );
    } finally {
      journal.close();
    }
  });

  it('completed processing with an interpreter failure preserves error receipt across recovery without model success', async () => {
    let calls = 0;
    const { boopy, deps, journal } = testBoopy({
      interpreter: {
        provider: 'fixture',
        model: 'synthetic-failure',
        async interpret() {
          calls++;
          throw new Error(
            'synthetic-secret-token-123 prompt=synthetic-private-camera-description Authorization=Bearer synthetic-provider-key',
          );
        },
      },
    });
    try {
      const request = StartSessionRequest.parse({
        ...startRequest('Synthetic error receipt.'),
        requestId,
      });
      const first = await boopy.start(request);
      assert.equal(first.notice, 'Could not interpret that. Please try again.');
      const privateDetail =
        /synthetic-secret-token-123|synthetic-private-camera-description|synthetic-provider-key|Authorization=Bearer/;
      assert.doesNotMatch(JSON.stringify(first), privateDetail);
      assert.doesNotMatch(JSON.stringify(journal.all()), privateDetail);
      assert.equal(first.items.length, 0);
      const count = journal.all().length;
      const recovered = new Boopy(deps).startStatus(requestId);
      assert.equal(recovered.status, 'succeeded');
      assert.ok(recovered.view);
      assert.equal(recovered.view.notice, first.notice);
      assert.doesNotMatch(JSON.stringify(recovered), privateDetail);
      assert.equal(recovered.view.items.length, 0);
      assert.equal(recovered.view.model, null);
      assert.equal((await new Boopy(deps).start(request)).notice, first.notice);
      assert.equal(calls, 1);
      assert.equal(journal.all().length, count);
      assert.equal(
        journal.all().filter((event) => event.type === 'interpretation.failed').length,
        1,
      );
    } finally {
      journal.close();
    }
  });

  it('early nothing-to-save completion keeps its actual receipt without claiming a save after restart', async () => {
    const { boopy, deps, journal } = testBoopy();
    try {
      const request = StartSessionRequest.parse({
        cues: {},
        speech: { text: 'Save' },
        attention: { source: 'unknown', scope: 'scene', evidence: 'none' },
        requestId,
      });
      const first = await boopy.start(request);
      assert.match(first.notice ?? '', /nothing to save/);
      assert.equal(first.state, 'review');
      assert.equal(first.committed, null);
      assert.equal(first.items.length, 0);
      const count = journal.all().length;
      const replay = await new Boopy(deps).start(request);
      assert.equal(replay.notice, first.notice);
      assert.equal(replay.committed, null);
      assert.equal(replay.dialogue?.utteranceId, replay.utterances.at(-1)?.id);
      assert.equal(journal.all().length, count);
    } finally {
      journal.close();
    }
  });

  it('OCR failure stays empty and never becomes invented source text or repeated model work', async () => {
    let interpretations = 0,
      reads = 0;
    const fixture = new FixtureInterpreter();
    const { boopy, deps, journal, text } = testBoopy({
      interpreter: {
        provider: 'fixture',
        model: 'synthetic-ocr-check',
        async interpret(input) {
          interpretations++;
          assert.deepEqual(input.text, []);
          return fixture.interpret(input);
        },
      },
    });
    text.read = async () => {
      reads++;
      throw new Error('Synthetic OCR unavailable.');
    };
    try {
      const request = StartSessionRequest.parse({
        ...startRequest('Synthetic OCR fallback.'),
        requestId,
      });
      const first = await boopy.start(request);
      assert.equal(
        first.items.some((item) => item.text !== undefined && item.text.length > 0),
        false,
      );
      assert.equal(boopy.startStatus(requestId).status, 'succeeded');
      await new Boopy(deps).start(request);
      assert.equal(reads, 1);
      assert.equal(interpretations, 1);
      assert.equal(journal.all().filter((event) => event.type === 'text.read').length, 0);
    } finally {
      journal.close();
    }
  });

  it('restart marks journaled unfinished start interrupted once and recovers actual partial session without resuming', async () => {
    const original = testBoopy();
    const replayJournal = Journal.open(':memory:');
    try {
      const request = StartSessionRequest.parse({
        ...startRequest('Synthetic interrupted request.'),
        requestId,
      });
      await original.boopy.start(request);
      const start = original.journal.all().find((event) => event.type === 'session.started');
      assert.ok(start);
      replayJournal.append(start, 'synthetic-start-event', start.at);
      const replay = new Boopy({ ...original.deps, journal: replayJournal });
      const status = replay.startStatus(requestId);
      assert.equal(status.status, 'interrupted');
      assert.equal(status.sessionId, start.session);
      assert.equal(status.view, null);
      assert.equal(replay.view(start.session).observations.length, 0);
      await assert.rejects(replay.start(request), matchesCode('start_interrupted'));
      assert.equal(
        replayJournal.all().filter((event) => event.type === 'session.start.finished').length,
        1,
      );
      const count = replayJournal.all().length;
      assert.equal(
        new Boopy({ ...original.deps, journal: replayJournal }).startStatus(requestId).status,
        'interrupted',
      );
      assert.equal(replayJournal.all().length, count);
    } finally {
      original.journal.close();
      replayJournal.close();
    }
  });

  it('REST recovery stays loopback-only and absent from connector, with invalid/unknown IDs denied', async () => {
    const { boopy, journal } = testBoopy();
    const app = headsetApp(boopy, { logger: false });
    const connector = connectorApp(boopy, {
      token: 'synthetic-token',
      baseUrl: 'http://127.0.0.1',
      logger: false,
    });
    try {
      const request = StartSessionRequest.parse({
        cues: {},
        speech: { text: 'Synthetic spoken context.' },
        attention: { source: 'unknown', scope: 'scene', evidence: 'none' },
        requestId,
      });
      const view = await boopy.start(request);
      const recovered = await app.inject({ method: 'GET', url: `/v1/session-starts/${requestId}` });
      assert.equal(recovered.statusCode, 200);
      assert.equal(recovered.json().sessionId, view.id);
      assert.equal(recovered.json().status, 'succeeded');
      assert.equal(recovered.headers['cache-control'], 'no-store');
      assert.equal(recovered.json().view.id, view.id);
      assert.equal(
        (
          await app.inject({
            method: 'GET',
            url: `/v1/session-starts/${requestId}`,
            headers: { host: 'untrusted.invalid' },
          })
        ).statusCode,
        403,
      );
      assert.equal(
        (await app.inject({ method: 'GET', url: '/v1/session-starts/not-a-uuid' })).statusCode,
        400,
      );
      const unknown = await app.inject({
        method: 'GET',
        url: '/v1/session-starts/682b16a5-ea1b-4d53-b768-b66854860391',
      });
      assert.equal(unknown.statusCode, 404);
      assert.equal(unknown.json().error.code, 'start_unknown');
      const hidden = await connector.inject({
        method: 'GET',
        url: `/v1/session-starts/${requestId}`,
        headers: { authorization: 'Bearer synthetic-token' },
      });
      assert.equal(hidden.statusCode, 404);
      const before = journal.all().length;
      const malformed = await app.inject({
        method: 'POST',
        url: '/v1/sessions',
        payload: { ...request, requestId: 'not-a-uuid' },
      });
      assert.equal(malformed.statusCode, 400);
      assert.equal(journal.all().length, before);
    } finally {
      await app.close();
      await connector.close();
      journal.close();
    }
  });

  it('keyless starts retain fresh-session behavior without a recovery association', async () => {
    const { boopy, journal } = testBoopy();
    try {
      const request = StartSessionRequest.parse({
        cues: {},
        speech: { text: 'Synthetic legacy nonvisual request.' },
        attention: { source: 'unknown', scope: 'scene', evidence: 'none' },
      });
      const first = await boopy.start(request),
        second = await boopy.start(request);
      assert.notEqual(first.id, second.id);
      assert.equal(journal.all().filter((event) => event.type === 'session.started').length, 2);
      assert.equal(
        journal.all().filter((event) => event.type === 'session.start.finished').length,
        0,
      );
    } finally {
      journal.close();
    }
  });
});
