/** Temporary synthetic REST-only exposure boundary. Does not open a tunnel. */
import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';

export async function startMuseDemoGate(
  options: { ttlMs?: number; upstreamTimeoutMs?: number; rateWindowMs?: number } = {},
) {
  const ttlMs = options.ttlMs ?? 15 * 60 * 1000;
  const timeoutMs = options.upstreamTimeoutMs ?? 5000;
  const windowMs = options.rateWindowMs ?? 60000;
  for (const [value, maximum] of [
    [ttlMs, 30 * 60 * 1000],
    [timeoutMs, 5000],
    [windowMs, 60000],
  ])
    if (!Number.isInteger(value) || (value ?? 0) < 1 || (value ?? Infinity) > (maximum ?? 0))
      throw new Error('Invalid demo gate bounds.');
  let active: { origin: URL; upstream: URL; path: string } | null = null;
  let count = 0,
    windowStart = Date.now(),
    inflight = 0;
  // Fixed aggregate keys only: never retain request metadata or credential presence.
  const diagnostics = {
    received: 0,
    forwarded: 0,
    refused: 0,
    upstreamResponses: 0,
    upstreamErrors: 0,
    upstreamTimeouts: 0,
    malformedRequests: 0,
    forwardedByRoute: { health: 0, schema: 0, list: 0, package: 0 },
  };
  const upstreams = new Set<ReturnType<typeof httpRequest>>();
  const server = createServer(
    { maxHeaderSize: 8192, headersTimeout: 5000, requestTimeout: 5000 },
    (req, res) => {
      diagnostics.received++;
      const deny = (status: number, refusal = true) => {
        if (refusal) diagnostics.refused++;
        res.writeHead(status, { 'cache-control': 'no-store', connection: 'close' });
        res.end();
      };
      if (Date.now() - windowStart >= windowMs) {
        windowStart = Date.now();
        count = 0;
      }
      if (++count > 30) {
        deny(429);
        return;
      }
      if (active === null) {
        deny(503);
        return;
      }
      const configured = active;
      if (req.headers.host !== configured.origin.host) {
        deny(403);
        return;
      }
      if (req.headers.origin !== undefined && req.headers.origin !== configured.origin.origin) {
        deny(403);
        return;
      }
      if (req.method !== 'GET') {
        deny(405);
        return;
      }
      if (
        req.headers['transfer-encoding'] !== undefined ||
        (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0')
      ) {
        deny(413);
        return;
      }
      const raw = req.url ?? '';
      const separator = raw.indexOf('?');
      const path = separator < 0 ? raw : raw.slice(0, separator);
      if (
        !['/health', '/openapi.json', '/v1/context', configured.path].includes(path) ||
        (separator >= 0 && path !== '/v1/context') ||
        raw.length > 1024
      ) {
        deny(404);
        return;
      }
      if (separator >= 0) {
        const query = new URLSearchParams(raw.slice(separator + 1));
        if (
          [...query.keys()].some((key) => key !== 'query' && key !== 'limit') ||
          query.getAll('query').length > 1 ||
          query.getAll('limit').length > 1 ||
          (query.get('query')?.length ?? 0) > 500
        ) {
          deny(400);
          return;
        }
      }
      if (inflight >= 2) {
        deny(429);
        return;
      }
      const category =
        path === '/health'
          ? 'health'
          : path === '/openapi.json'
            ? 'schema'
            : path === '/v1/context'
              ? 'list'
              : 'package';
      diagnostics.forwardedByRoute[category]++;
      diagnostics.forwarded++;
      inflight++;
      let finished = false;
      const release = () => {
        if (!finished) {
          finished = true;
          inflight--;
        }
      };
      const headers: Record<string, string> = { host: configured.origin.host };
      if (req.headers.authorization !== undefined)
        headers.authorization = req.headers.authorization;
      // Identity remains self-reported; do not forward arbitrary client/tunnel headers.
      headers['x-boopy-agent'] = 'synthetic-muse-demo';
      const upstream = httpRequest(
        new URL(raw, configured.upstream),
        { method: 'GET', headers },
        (response) => {
          diagnostics.upstreamResponses++;
          const forwarded: Record<string, string> = { 'cache-control': 'no-store' };
          if (typeof response.headers['content-type'] === 'string')
            forwarded['content-type'] = response.headers['content-type'];
          if (typeof response.headers['www-authenticate'] === 'string')
            forwarded['www-authenticate'] = response.headers['www-authenticate'];
          res.writeHead(response.statusCode ?? 502, forwarded);
          response.pipe(res);
          response.once('error', () => res.destroy());
        },
      );
      upstreams.add(upstream);
      const timer = setTimeout(() => {
        diagnostics.upstreamTimeouts++;
        upstream.destroy(new Error('timeout'));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        upstreams.delete(upstream);
        release();
      };
      upstream.once('error', () => {
        diagnostics.upstreamErrors++;
        if (!res.headersSent) deny(502, false);
        else res.destroy();
        cleanup();
      });
      res.once('close', () => {
        upstream.destroy();
        cleanup();
      });
      res.once('finish', cleanup);
      upstream.end();
    },
  );
  server.on('clientError', (_error, socket) => {
    diagnostics.malformedRequests++;
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });
  server.maxConnections = 32;
  server.setTimeout(timeoutMs, (socket) => socket.destroy());
  server.keepAliveTimeout = Math.min(1000, timeoutMs);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  let finish: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let closing: Promise<void> | undefined;
  const close = () => {
    closing ??= new Promise<void>((resolve) => {
      clearTimeout(ttl);
      active = null;
      for (const upstream of upstreams) upstream.destroy();
      server.closeAllConnections();
      server.close(() => {
        resolve();
        finish();
      });
    });
    return closing;
  };
  const ttl = setTimeout(() => {
    void close();
  }, ttlMs);
  return {
    localUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    activate(input: { origin: string; upstreamUrl: string; packageId: string }) {
      if (active || closing) throw new Error('Demo gate cannot be activated.');
      let origin: URL, upstream: URL;
      try {
        origin = new URL(input.origin);
        upstream = new URL(input.upstreamUrl);
      } catch {
        throw new Error('Invalid demo gate destination.');
      }
      if (
        origin.protocol !== 'https:' ||
        origin.username ||
        origin.password ||
        origin.pathname !== '/' ||
        origin.search ||
        origin.hash ||
        upstream.protocol !== 'http:' ||
        upstream.hostname !== '127.0.0.1' ||
        !upstream.port ||
        upstream.username ||
        upstream.password ||
        upstream.pathname !== '/' ||
        upstream.search ||
        upstream.hash ||
        !/^[a-zA-Z0-9_-]{1,160}$/.test(input.packageId)
      )
        throw new Error('Invalid demo gate destination.');
      active = { origin, upstream, path: `/v1/context/${input.packageId}` };
    },
    diagnostics: () => ({ ...diagnostics, forwardedByRoute: { ...diagnostics.forwardedByRoute } }),
    close,
    closed,
  };
}
