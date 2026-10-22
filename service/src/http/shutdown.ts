import type { ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';

/**
 * How long a stop lets requests in progress run before their connections are cut. The headset
 * gives up on control requests after 10 s itself. A session start still waiting on a model after
 * this is cut and marked interrupted when Boopy starts again.
 */
export const CLOSE_GRACE_MS = 10_000;

/**
 * Makes `app.close()` end as soon as the requests in progress finish, or after `graceMs`. Node's
 * `server.close()` closes idle keep-alive connections at once, but a connection that is busy when
 * close begins would stay open for the keep-alive timeout (72 s in fastify 5) after its response.
 * So a response sent while closing carries `Connection: close`, a connection whose response had
 * already started closes when that response ends, and whatever is still open `graceMs` after
 * close began is destroyed.
 */
export function drainOnClose(app: FastifyInstance, graceMs: number): void {
  const inProgress = new Set<ServerResponse>();
  let closing = false;
  app.server.on('request', (_request, response: ServerResponse) => {
    // Once closing, fastify itself answers new requests with 503 and Connection: close.
    if (closing) return;
    inProgress.add(response);
    response.once('close', () => inProgress.delete(response));
  });
  let grace: NodeJS.Timeout | undefined;
  app.addHook('preClose', async () => {
    closing = true;
    for (const response of inProgress) {
      if (!response.headersSent) response.setHeader('connection', 'close');
      response.once('finish', () => app.server.closeIdleConnections());
    }
    grace = setTimeout(() => app.server.closeAllConnections(), graceMs).unref();
  });
  app.addHook('onClose', async () => clearTimeout(grace));
}
