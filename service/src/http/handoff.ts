import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { BoopyError } from '../boopy.ts';
import { type HandoffPreparation, HandoffPreparationRequest } from '../handoff-preparation.ts';

const Params = z.object({
  sessionId: z.string().min(1).max(160),
  requestId: z
    .string()
    .regex(/^[a-zA-Z0-9_-]{1,128}$/)
    .optional(),
});

/** Native headset metadata only. Packet contents and filesystem paths are never served here. */
export function registerHandoffRoutes(app: FastifyInstance, preparation: HandoffPreparation) {
  const nativeOnly = async (request: FastifyRequest) => {
    if (request.headers.origin !== undefined)
      throw new BoopyError(403, 'browser_not_allowed', 'Use Boopy to prepare this context.');
  };
  app.post(
    '/v1/sessions/:sessionId/handoff-preparations',
    {
      onRequest: nativeOnly,
    },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? ''))
        throw new BoopyError(415, 'json_required', 'Send a JSON preparation request.');
      const { sessionId } = Params.parse(request.params);
      const input = HandoffPreparationRequest.parse(request.body);
      try {
        // Work survives a disconnected headset; the same request ID recovers its exact receipt.
        const work = preparation.prepare(sessionId, input);
        void work.catch(() => {});
        const status = preparation.status(sessionId, input.requestId);
        if (!status) throw new Error('Missing preparation state.');
        return reply.code(status.state === 'prepared-local' ? 200 : 202).send(status);
      } catch {
        throw new BoopyError(409, 'preparation_refused', 'This context could not be prepared.');
      }
    },
  );
  app.get(
    '/v1/sessions/:sessionId/handoff-preparations/:requestId',
    {
      onRequest: nativeOnly,
    },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const { sessionId, requestId } = Params.parse(request.params);
      try {
        if (!requestId) throw new Error('Missing request ID.');
        const status = preparation.status(sessionId, requestId);
        if (status) return status;
      } catch {
        // Unknown and another session's request are indistinguishable to a caller.
      }
      throw new BoopyError(404, 'preparation_unavailable', 'No preparation receipt is available.');
    },
  );
}
