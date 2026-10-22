import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ActivityFileError, type ActivityStore } from '../activity.ts';
import type { ActivityCalls } from '../activity-call.ts';
import { ContentInput } from '../activity-contract.ts';
import { BoopyError } from '../boopy.ts';

/**
 * Fastify decodes route parameters, so an identifier must also appear literally in the raw path:
 * a percent-encoded or padded identifier names no activity.
 */
function literal(request: FastifyRequest, name: string, segment: number, code: string) {
  const value = (request.params as Record<string, string>)[name];
  const raw = request.raw.url?.split('?')[0]?.split('/')[segment];
  if (value === undefined || raw !== value)
    throw new BoopyError(
      404,
      code,
      code === 'activity_unknown'
        ? 'No such activity.'
        : code === 'call_unknown'
          ? 'No such call.'
          : 'No such submission.',
    );
  return value;
}

/** A refused file keeps its issues; every other refusal goes to the app's error handler. */
async function answer(reply: FastifyReply, work: () => unknown) {
  try {
    return await work();
  } catch (failure) {
    if (!(failure instanceof ActivityFileError)) throw failure;
    return reply.code(failure.status).send({
      error: { code: failure.code, message: failure.message, issues: failure.issues },
    });
  }
}

/** Section 4, on the loopback headset API. A browser page cannot use these routes. */
export function registerActivityRoutes(
  app: FastifyInstance,
  store: ActivityStore,
  calls?: ActivityCalls,
) {
  const nativeOnly = async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header('Cache-Control', 'no-store');
    if (request.headers.origin !== undefined)
      throw new BoopyError(403, 'browser_not_allowed', 'Use Boopy for activities.');
  };
  const id = (request: FastifyRequest) => literal(request, 'activityId', 3, 'activity_unknown');
  app.post(
    '/v1/activities/practice-requests',
    { onRequest: nativeOnly },
    async (request, reply) => {
      if (!calls) throw unavailable();
      return reply.code(202).send(await calls.askForPractice(request.body));
    },
  );
  app.get('/v1/activity-calls', { onRequest: nativeOnly }, async () => ({ calls: store.calls() }));
  app.get('/v1/activity-calls/:callId', { onRequest: nativeOnly }, async (request) =>
    store.call(literal(request, 'callId', 3, 'call_unknown')),
  );
  app.get('/v1/activities', { onRequest: nativeOnly }, async () => ({ activities: store.list() }));
  app.get('/v1/activities/:activityId', { onRequest: nativeOnly }, async (request) =>
    store.view(id(request)),
  );
  app.post('/v1/activities/:activityId/arrangement', { onRequest: nativeOnly }, async (request) =>
    store.arrange(id(request), request.body),
  );
  app.post('/v1/activities/:activityId/sequence', { onRequest: nativeOnly }, async (request) =>
    store.sequence(id(request), request.body),
  );
  app.post('/v1/activities/:activityId/hints', { onRequest: nativeOnly }, async (request) =>
    store.revealHint(id(request), request.body),
  );
  app.post('/v1/activities/:activityId/submissions', { onRequest: nativeOnly }, async (request) =>
    calls ? calls.submit(id(request), request.body) : store.submit(id(request), request.body),
  );
}

/**
 * Section 5, on the connector behind its bearer token and the same local-only guard as
 * /v1/local-handoffs. Absent from OpenAPI and MCP. Files come back as content; the command-line
 * tool writes them.
 */
export function registerLocalActivityRoutes(
  app: FastifyInstance,
  store: ActivityStore,
  localOnly: (request: FastifyRequest) => Promise<void>,
  calls?: ActivityCalls,
) {
  const options = {
    onRequest: [
      localOnly,
      async (_request: FastifyRequest, reply: FastifyReply) => {
        reply
          .header('Cache-Control', 'no-store')
          .header('X-Content-Type-Options', 'nosniff')
          .header('Referrer-Policy', 'no-referrer');
      },
    ],
  };
  app.post('/v1/local-activities/practice-requests', options, async (request, reply) => {
    if (!calls) throw unavailable();
    return reply.code(202).send(await calls.askForPractice(request.body));
  });
  app.get('/v1/local-activities/calls/:callId', options, async (request) =>
    store.call(literal(request, 'callId', 4, 'call_unknown')),
  );
  app.post('/v1/local-activities/requests', options, async (request) =>
    store.prepareRequest(request.body),
  );
  app.post('/v1/local-activities/imports', options, async (request, reply) =>
    answer(reply, () => store.importActivity(ContentInput.parse(request.body).content)),
  );
  app.post('/v1/local-activities/submissions/:submissionId/export', options, async (request) =>
    store.exportSubmission(literal(request, 'submissionId', 4, 'submission_unknown')),
  );
  app.post('/v1/local-activities/replies', options, async (request, reply) =>
    answer(reply, () => store.importReply(ContentInput.parse(request.body).content)),
  );
}

function unavailable() {
  return new BoopyError(
    503,
    'assistant_unavailable',
    'The local activity assistant is unavailable.',
  );
}
