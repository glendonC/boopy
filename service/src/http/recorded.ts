import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { BoopyError } from '../boopy.ts';
import type { RecordedScenes } from '../recorded-source.ts';

/**
 * The headset's view of a recorded scene: the shown recording and its stills. These routes give
 * the owner's footage out, so a browser page is refused outright (an Origin header, or any
 * Sec-Fetch-Site but "none"), nothing is cached, and no CORS header is ever sent.
 */
export function registerRecordedSceneRoutes(app: FastifyInstance, scenes: RecordedScenes) {
  const options = {
    onRequest: async (request: FastifyRequest, reply: FastifyReply) => {
      reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff');
      const site = request.headers['sec-fetch-site'];
      if (request.headers.origin !== undefined || (site !== undefined && site !== 'none'))
        throw new BoopyError(403, 'browser_not_allowed', 'Recorded scenes are for Boopy only.');
    },
  };
  app.get('/v1/recorded-scene', options, async () => ({ scene: scenes.scene() }));
  app.get('/v1/recorded-scene/outlines', options, async () => scenes.outlines());
  app.get('/v1/recorded-scene/frames/:frameId', options, async (request, reply) =>
    reply.type('image/jpeg').send(scenes.frame((request.params as { frameId: string }).frameId)),
  );
}

/**
 * The operator's steps on the Mac, on the connector behind its token and the local-only guard:
 * import a file already placed in the store, list recordings, show one, clear it.
 */
export function registerLocalRecordedRoutes(
  app: FastifyInstance,
  scenes: RecordedScenes,
  localOnly: (request: FastifyRequest) => Promise<void>,
) {
  const options = {
    onRequest: [
      localOnly,
      async (_request: FastifyRequest, reply: FastifyReply) => {
        reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff');
      },
    ],
  };
  app.post('/v1/local-recorded/imports', options, async (request) =>
    scenes.importSource(request.body),
  );
  app.get('/v1/local-recorded/recordings', options, async () => ({
    recordings: scenes.recordings(),
  }));
  app.post('/v1/local-recorded/scene', options, async (request) => ({
    scene: scenes.show(request.body),
  }));
  app.post('/v1/local-recorded/outlines', options, async (request, reply) =>
    reply.code(202).send(scenes.startOutlines(request.body)),
  );
  app.post('/v1/local-recorded/scene/clear', options, async () => {
    scenes.clear();
    return { scene: null };
  });
}
