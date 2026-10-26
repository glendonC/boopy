import { PassThrough } from 'node:stream';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ActivityStore } from '../activity.ts';
import type { ActivityCalls } from '../activity-call.ts';
import { type Boopy, BoopyError } from '../boopy.ts';
import {
  ActionRequest,
  ChoiceSelection,
  type SessionView,
  SpeechOutputRequest,
  StartSessionRequest,
  UtteranceRequest,
} from '../contracts.ts';
import type { TurnStage } from '../events.ts';
import { SupersedeRequest } from '../evidence-contract.ts';
import type { GrokBotMoments } from '../grok-bot.ts';
import type { HandoffPreparation } from '../handoff-preparation.ts';
import type { TaskStore } from '../interaction/tasks.ts';
import { type LiveObservation, SceneObservationRequest } from '../live-observation.ts';
import type { RecordedScenes } from '../recorded-source.ts';
import { registerActivityRoutes } from './activities.ts';
import { registerHandoffRoutes } from './handoff.ts';
import { registerRecordedSceneRoutes } from './recorded.ts';
import { CLOSE_GRACE_MS, drainOnClose } from './shutdown.ts';
import { type PracticeLink, registerTaskRoutes } from './tasks.ts';

/** Frames are about 200 KB and clips up to 30 s of 16 kHz audio; base64 adds a third. */
const BODY_LIMIT = 8 * 1024 * 1024;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * The headset's API. Loopback only: the Quest reaches it over USB through `adb reverse`, and a
 * Host check stops web pages from reaching it through DNS rebinding. Never exposed through a
 * tunnel; agents use the connector instead.
 */
export function headsetApp(
  boopy: Boopy,
  options: {
    readonly logger: boolean;
    readonly liveScene?: LiveObservation;
    readonly handoff?: HandoffPreparation;
    readonly activities?: ActivityStore;
    readonly activityCalls?: ActivityCalls;
    readonly tasks?: TaskStore;
    /** Zetaris on this Mac for practice under the person's goal; only with it set up. */
    readonly practice?: PracticeLink;
    /** The person's own Grok Bot, sent each boop moment; only with a webhook file. */
    readonly grokBot?: GrokBotMoments;
    /** A recorded scene for the headset to show and boop; only with BOOPY_RECORDED_SCENE=1. */
    readonly recorded?: RecordedScenes;
    /** How long close() lets requests in progress run; tests shorten it. */
    readonly closeGraceMs?: number;
  },
): FastifyInstance {
  const app = Fastify({
    bodyLimit: BODY_LIMIT,
    logger: options.logger ? { level: 'info' } : false,
  });
  drainOnClose(app, options.closeGraceMs ?? CLOSE_GRACE_MS);

  app.addHook('onRequest', async (request, reply) => {
    const host = request.headers.host?.replace(/:\d+$/, '') ?? '';
    if (!LOOPBACK_HOSTS.has(host)) {
      await reply.code(403).send(error('forbidden_host', 'Only loopback hosts may call this API.'));
    }
  });
  app.setErrorHandler(handleError);

  app.get('/v1/health', async () => ({
    ok: true,
    service: 'boopy',
    speechOutputAvailable: boopy.speechOutputAvailable,
    handoffPreparationAvailable: options.handoff !== undefined,
    ...(options.activities ? { activities: true } : {}),
    ...(options.activityCalls ? { activityAssistant: options.activityCalls.capability } : {}),
    interpreter: boopy.interpreter,
    segmenter: boopy.segmenter,
    liveScene: options.liveScene
      ? {
          provider: options.liveScene.provider.provider,
          model: options.liveScene.provider.model,
          ...options.liveScene.diagnostics,
        }
      : null,
  }));

  app.post('/v1/scene/observe', async (request, reply) => {
    if (!options.liveScene)
      throw new BoopyError(503, 'scene_unavailable', 'Live scene recognition is unavailable.');
    const input = SceneObservationRequest.parse(request.body);
    const controller = new AbortController();
    const abort = () => {
      if (!reply.raw.writableEnded) controller.abort();
    };
    request.raw.once('aborted', abort);
    reply.raw.once('close', abort);
    reply.header('Cache-Control', 'no-store');
    try {
      return await options.liveScene.observe(input, controller.signal);
    } finally {
      request.raw.removeListener('aborted', abort);
      reply.raw.removeListener('close', abort);
    }
  });

  app.post('/v1/sessions', async (request, reply) => {
    const input = StartSessionRequest.parse(request.body);
    return wantsProgress(request)
      ? turnStream(reply, (progress) => boopy.start(input, progress))
      : boopy.start(input);
  });

  app.get('/v1/sessions/:id', async (request) => boopy.view(idOf(request)));

  app.get('/v1/session-starts/:requestId', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return boopy.startStatus((request.params as { requestId: string }).requestId);
  });

  app.post('/v1/sessions/:id/utterances', async (request, reply) => {
    const input = UtteranceRequest.parse(request.body);
    return wantsProgress(request)
      ? turnStream(reply, (progress) => boopy.utter(idOf(request), input, progress))
      : boopy.utter(idOf(request), input);
  });

  app.post('/v1/sessions/:id/choice-selection', async (request) =>
    boopy.selectChoice(idOf(request), ChoiceSelection.parse(request.body)),
  );
  app.post('/v1/sessions/:id/choice-submit', async (request, reply) => {
    const input = ChoiceSelection.parse(request.body);
    return wantsProgress(request)
      ? turnStream(reply, (progress) => boopy.submitChoice(idOf(request), input, progress))
      : boopy.submitChoice(idOf(request), input);
  });

  app.post('/v1/sessions/:id/actions', async (request) =>
    boopy.act(idOf(request), ActionRequest.parse(request.body)),
  );

  app.post('/v1/sessions/:id/commit', async (request) => boopy.commit(idOf(request)));

  app.post('/v1/sessions/:id/speech', async (request, reply) => {
    const input = SpeechOutputRequest.parse(request.body);
    const controller = new AbortController();
    const abort = () => {
      if (!reply.raw.writableEnded) controller.abort();
    };
    request.raw.once('aborted', abort);
    reply.raw.once('close', abort);
    reply.header('Cache-Control', 'no-store');
    try {
      return await boopy.speak(idOf(request), input, controller.signal);
    } finally {
      request.raw.removeListener('aborted', abort);
      reply.raw.removeListener('close', abort);
    }
  });

  app.post('/v1/evidence/supersede', async (request) =>
    boopy.supersede(SupersedeRequest.parse(request.body)),
  );

  if (options.handoff) registerHandoffRoutes(app, options.handoff);
  if (options.activities) registerActivityRoutes(app, options.activities, options.activityCalls);
  if (options.tasks)
    registerTaskRoutes(app, options.tasks, boopy, options.practice, options.grokBot);
  if (options.recorded) registerRecordedSceneRoutes(app, options.recorded);

  return app;
}

const idOf = (request: FastifyRequest) => (request.params as { id: string }).id;

const wantsProgress = (request: FastifyRequest) =>
  request.headers.accept?.split(',').some((value) => value.trim() === 'application/x-ndjson') ===
  true;

/** Operational stages, never model reasoning or unvalidated structured-output fragments. */
function turnStream(
  reply: FastifyReply,
  work: (progress: (stage: TurnStage) => void) => Promise<SessionView>,
) {
  const output = new PassThrough();
  let detached = false,
    count = 0;
  output.on('close', () => {
    detached = true;
  });
  reply.raw.once('close', () => {
    detached = true;
    output.destroy();
  });
  const send = (value: unknown) => {
    if (detached || output.destroyed) return;
    const line = `${JSON.stringify(value)}\n`;
    output.write(
      Buffer.byteLength(line) <= 2 * 1024 * 1024
        ? line
        : `${JSON.stringify({
            type: 'error',
            error: {
              code: 'response_too_large',
              message: 'The response is too large. Check the recorded conversation on your Mac.',
            },
          })}\n`,
    );
  };
  reply.header('Content-Type', 'application/x-ndjson').header('Cache-Control', 'no-store');
  const response = reply.send(output);
  void Promise.resolve()
    .then(() =>
      work((stage) => {
        if (++count <= 32) send({ type: 'stage', stage });
      }),
    )
    .then(
      (view) => send({ type: 'result', view }),
      (failure) =>
        send({
          type: 'error',
          error: {
            code:
              failure instanceof BoopyError && /^[a-z][a-z0-9_]{0,63}$/.test(failure.code)
                ? failure.code
                : 'internal',
            message: 'This turn could not finish. Check its status before trying again.',
          },
        }),
    )
    .finally(() => {
      if (!output.destroyed) output.end();
    });
  return response;
}

export function error(code: string, message: string) {
  return { error: { code, message } };
}

/** Refusals keep their status and words; invalid bodies say which field; anything else is a 500. */
export function handleError(failure: unknown, request: FastifyRequest, reply: FastifyReply) {
  if (failure instanceof BoopyError) {
    return reply.code(failure.status).send(error(failure.code, failure.message));
  }
  if (failure instanceof z.ZodError) {
    const issue = failure.issues[0];
    const where = issue === undefined ? '' : `${issue.path.join('.')}: `;
    return reply.code(400).send(error('invalid_request', `${where}${issue?.message ?? 'invalid'}`));
  }
  const status = (failure as { statusCode?: number }).statusCode;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    return reply.code(status).send(error('invalid_request', (failure as Error).message));
  }
  request.log.error({ err: failure }, 'request failed');
  return reply.code(500).send(error('internal', 'Something went wrong on the Mac.'));
}
