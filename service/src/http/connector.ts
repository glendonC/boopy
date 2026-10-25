import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { hostHeaderValidation, originValidation } from '@modelcontextprotocol/fastify';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer, ResourceTemplate } from '@modelcontextprotocol/server';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ActivityStore } from '../activity.ts';
import type { ActivityCalls } from '../activity-call.ts';
import type { Boopy } from '../boopy.ts';
import { BoopyError, summarize } from '../boopy.ts';
import type { ContextPackage } from '../contracts.ts';
import { evidenceRecords, evidenceSourceId } from '../evidence-contract.ts';
import type { HandoffPreparation } from '../handoff-preparation.ts';
import { SetGoal } from '../interaction/contract.ts';
import type { TaskStore } from '../interaction/tasks.ts';
import type { NvidiaEmbeddingWorker } from '../memory/nvidia.ts';
import { MemoryRecall } from '../memory/recall.ts';
import type { RecordedScenes } from '../recorded-source.ts';
import { registerLocalActivityRoutes } from './activities.ts';
import { error, handleError } from './headset.ts';
import { openApiDocument } from './openapi.ts';
import { registerLocalRecordedRoutes } from './recorded.ts';
import { CLOSE_GRACE_MS, drainOnClose } from './shutdown.ts';
import { registerLocalTaskRoutes } from './tasks.ts';

export interface ConnectorOptions {
  /** The bearer token agents must send. */
  readonly token: string;
  /** The URL agents use. Loopback, or a tunnel placed in front of it. */
  readonly baseUrl: string;
  readonly logger: boolean;
  readonly memory?: boolean;
  readonly handoff?: HandoffPreparation;
  /** Local operator activity routes; registered only beside the local handoff routes. */
  readonly activities?: ActivityStore;
  readonly activityCalls?: ActivityCalls;
  /** Local operator routes for a reply from a named connection; beside the handoff routes. */
  readonly tasks?: TaskStore;
  /** The operator's recorded-scene routes; only with BOOPY_RECORDED_SCENE=1. */
  readonly recorded?: RecordedScenes;
  /** The person's practice goal on the Mac; only with Zetaris practice set up. */
  readonly goal?: TaskStore;
  readonly semanticRanker?: Pick<NvidiaEmbeddingWorker, 'rank'>;
  /** How long close() lets requests in progress run; tests shorten it. */
  readonly closeGraceMs?: number;
}

const INSTRUCTIONS = `Boopy holds context the user saved about their physical world: observations, intent and corrections. Each committed package separates what the user explicitly confirmed, corrected or added from what a model proposed and the user only left standing ("accepted"), and lists what the user already knows or rejected. Use each claim's verification and provenance; saving does not establish that every item was reviewed or confirmed. Never present "accepted" items as confirmed by the user. Check correctionOverlay and read-time correction notices: saved snapshots are historical, and explicitly superseded claims must not support current answers. Fetch the indicated successor when needed.`;

/**
 * Read-only access to saved context for agents: MCP at /mcp and REST at /v1/context, both
 * behind a bearer token. Every read is written to the journal. Listens on loopback. A tunnel
 * in front of it can let a hosted agent such as Muse reach it.
 */
export function connectorApp(boopy: Boopy, options: ConnectorOptions): FastifyInstance {
  if (options.token.trim() === '') throw new Error('Connector token must be non-empty.');
  let publishedUrl: URL;
  try {
    publishedUrl = new URL(options.baseUrl);
  } catch {
    throw new Error('Connector URL must be a valid HTTP or HTTPS URL.');
  }
  if (!['http:', 'https:'].includes(publishedUrl.protocol))
    throw new Error('Connector URL must be a valid HTTP or HTTPS URL.');
  if (publishedUrl.username || publishedUrl.password || publishedUrl.search || publishedUrl.hash)
    throw new Error('Connector URL must not contain credentials, query or fragment.');
  const app = Fastify({
    bodyLimit: 1024 * 1024,
    logger: options.logger ? { level: 'info' } : false,
  });
  drainOnClose(app, options.closeGraceMs ?? CLOSE_GRACE_MS);
  const publicHost = publishedUrl.hostname;
  const hosts = ['127.0.0.1', 'localhost', '[::1]', publicHost];
  app.addHook('onRequest', hostHeaderValidation(hosts));
  app.addHook('onRequest', originValidation(hosts));
  app.addHook('onRequest', async (request, reply) => {
    // Fastify decodes route segments before matching. Raw URL prefix checks can miss an
    // encoded data route, so only the two actual matched public routes bypass authentication.
    const route = request.routeOptions.url;
    if (route === '/health' || route === '/openapi.json') return;
    if (!authorized(request.headers.authorization, options.token)) {
      await reply
        .code(401)
        .header('www-authenticate', 'Bearer')
        .send(error('unauthorized', 'Send the connector token as a bearer token.'));
    }
  });
  app.setErrorHandler(handleError);

  app.get('/health', async () => ({ ok: true }));
  app.get('/openapi.json', async () => openApiDocument(options.baseUrl, options.memory ?? false));

  app.get('/v1/context', async (request) => {
    const query = z
      .object({
        query: z.string().max(500).default(''),
        limit: z.coerce.number().int().min(1).max(50).default(10),
      })
      .parse(request.query);
    const found = search(boopy.packages(), query.query, query.limit);
    for (const pkg of found) boopy.disclose(pkg, agentOf(request.headers), 'rest', 'list');
    return { results: found.map((pkg) => card(pkg, options.baseUrl)) };
  });

  app.get('/v1/context/:id', async (request, reply) => {
    const pkg = boopy.package((request.params as { id: string }).id);
    if (pkg === undefined) return reply.code(404).send(error('not_found', 'No such context.'));
    boopy.disclose(pkg, agentOf(request.headers), 'rest', 'get');
    return deliveredPackage(boopy, pkg);
  });

  if (options.memory) {
    app.post('/v1/recall', async (request) =>
      recall(
        boopy,
        RecallRequest.parse(request.body),
        agentOf(request.headers),
        'rest',
        options.semanticRanker,
      ),
    );
  }

  if (options.handoff) {
    const handoff = options.handoff;
    const localOnly = async (request: FastifyRequest) => {
      const host = request.headers.host?.replace(/:\d+$/, '') ?? '';
      const remote = request.raw.socket.remoteAddress;
      if (
        !['127.0.0.1', 'localhost', '[::1]'].includes(host) ||
        !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote ?? '') ||
        request.headers.origin !== undefined ||
        Object.keys(request.headers).some(
          (name) => name === 'forwarded' || name.startsWith('x-forwarded-') || name === 'x-real-ip',
        )
      )
        throw new BoopyError(403, 'local_operator_only', 'Use the local prepared export tool.');
    };
    for (const packet of [false, true])
      app.get(
        `/v1/local-handoffs/:packageId${packet ? '/packet' : ''}`,
        { onRequest: localOnly },
        async (request, reply) => {
          reply
            .header('Cache-Control', 'no-store')
            .header('X-Content-Type-Options', 'nosniff')
            .header('Referrer-Policy', 'no-referrer');
          try {
            const packageId = (request.params as { packageId: string }).packageId;
            const query = z
              .object({
                request: z
                  .string()
                  .regex(/^[a-zA-Z0-9_-]{1,128}$/)
                  .optional(),
                list: z.literal('true').optional(),
              })
              .strict()
              .parse(request.query);
            if (query.list) {
              if (packet || query.request) throw new Error();
              return handoff.listForPackage(packageId);
            }
            const status = handoff.forPackage(packageId, query.request);
            if (!packet) return status;
            const text = await handoff.readPacket(status.sessionId, status.requestId);
            return reply
              .header('Content-Disposition', 'attachment; filename="boopy-prepared-context.txt"')
              .type('text/plain; charset=utf-8')
              .send(text);
          } catch {
            throw new BoopyError(404, 'prepared_unavailable', 'Prepared handoff unavailable.');
          }
        },
      );
    if (options.activities)
      registerLocalActivityRoutes(app, options.activities, localOnly, options.activityCalls);
    if (options.tasks) registerLocalTaskRoutes(app, boopy, options.tasks, localOnly);
    if (options.recorded) registerLocalRecordedRoutes(app, options.recorded, localOnly);
    const goal = options.goal;
    // The person sets the language they practise; the journal records them as its author.
    if (goal)
      app.post(
        '/v1/local-tasks/goal',
        { onRequest: localOnly, bodyLimit: 4096 },
        async (request, reply) => {
          reply.header('Cache-Control', 'no-store');
          const outcome = goal.setGoal(SetGoal.parse(request.body), new Date().toISOString());
          if (outcome.status === 'rejected')
            throw new BoopyError(409, outcome.code, 'This event id names another goal.');
          return { goal: goal.goal() };
        },
      );
  }

  const mcp = toNodeHandler(
    createMcpHandler((context) =>
      contextServer(
        boopy,
        agentOf(context.requestInfo?.headers),
        options.baseUrl,
        options.memory ?? false,
        options.semanticRanker,
      ),
    ),
  );
  app.route({
    method: ['GET', 'POST', 'DELETE'],
    url: '/mcp',
    handler: async (request, reply) => {
      reply.hijack();
      await mcp(request.raw as IncomingMessage, reply.raw, request.body);
    },
  });

  return app;
}

function authorized(header: string | undefined, token: string): boolean {
  const given = Buffer.from(header?.startsWith('Bearer ') ? header.slice(7) : '');
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

type Headers = FastifyRequest['headers'] | globalThis.Headers | undefined;

/** Who is reading, as the client names itself; recorded with every disclosure. */
function agentOf(headers: Headers): string {
  const read = (name: string) =>
    headers === undefined
      ? undefined
      : headers instanceof globalThis.Headers
        ? (headers.get(name) ?? undefined)
        : (headers[name] as string | undefined);
  const named = read('x-boopy-agent') ?? read('user-agent') ?? 'unknown';
  return named.replace(/[^\x20-\x7e]/g, '').slice(0, 60) || 'unknown';
}

/** Newest first; with a query, packages ranked by how many of its words they contain. */
export function search(packages: ContextPackage[], query: string, limit: number): ContextPackage[] {
  const words = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 1);
  if (words.length === 0) return packages.slice(0, limit);
  return packages
    .map((pkg) => {
      const title = pkg.title.toLowerCase();
      const text = pkg.text.toLowerCase();
      const score = words.reduce(
        (sum, word) => sum + (title.includes(word) ? 2 : 0) + (text.includes(word) ? 1 : 0),
        0,
      );
      return { pkg, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.pkg);
}

function card(pkg: ContextPackage, baseUrl: string) {
  return {
    id: pkg.id,
    title: pkg.title,
    committedAt: pkg.committedAt,
    summary: summarize(pkg),
    url: `${baseUrl}/v1/context/${pkg.id}`,
  };
}

function contextServer(
  boopy: Boopy,
  agent: string,
  baseUrl: string,
  memory: boolean,
  semanticRanker?: Pick<NvidiaEmbeddingWorker, 'rank'>,
): McpServer {
  const server = new McpServer({ name: 'boopy', version: '0.1.0' }, { instructions: INSTRUCTIONS });
  const readOnly = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };

  if (memory) {
    server.registerTool(
      'recall',
      {
        title: 'Recall selected committed evidence',
        description:
          'Local H-MEM subset recall over explicit package IDs. Preserves unconfirmed evidence and known/rejected constraints. Superseded sources are excluded; results are not human confirmation.',
        inputSchema: RecallRequest,
        annotations: readOnly,
      },
      async (request) => ({
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(await recall(boopy, request, agent, 'mcp', semanticRanker)),
          },
        ],
      }),
    );
  }

  server.registerTool(
    'search',
    {
      title: 'Search committed context',
      description:
        "Search context the user saved with Boopy: observations, intent and corrections. Packages can include unconfirmed model proposals; fetch a package to inspect each claim's verification and provenance. Returns matching context packages, ranked by query match; an empty query returns the most recent.",
      inputSchema: z.object({
        query: z
          .string()
          .describe('Words to look for, such as a place, an object or a goal. May be empty.'),
      }),
      annotations: readOnly,
    },
    async ({ query }) => {
      const found = search(boopy.packages(), query, 10);
      for (const pkg of found) boopy.disclose(pkg, agent, 'mcp', 'search');
      const results = found.map((pkg) => ({
        id: pkg.id,
        title: pkg.title,
        url: card(pkg, baseUrl).url,
      }));
      return { content: [{ type: 'text', text: JSON.stringify({ results }) }] };
    },
  );

  server.registerTool(
    'fetch',
    {
      title: 'Fetch committed context',
      description:
        "Fetch one Boopy context package by id: the user's intent, items the user confirmed, corrected or added, items a model proposed that the user left standing, what the user already knows or rejected, open questions, and provenance.",
      inputSchema: z.object({ id: z.string().describe('A package id from search.') }),
      annotations: readOnly,
    },
    async ({ id }) => {
      const pkg = boopy.package(id);
      if (pkg === undefined) {
        return { content: [{ type: 'text', text: `No context with id ${id}.` }], isError: true };
      }
      boopy.disclose(pkg, agent, 'mcp', 'fetch');
      const delivered = deliveredPackage(boopy, pkg);
      const document = {
        id: pkg.id,
        title: pkg.title,
        text: delivered.text,
        url: card(pkg, baseUrl).url,
        metadata: {
          committedAt: pkg.committedAt,
          scope: pkg.scope,
          summary: summarize(pkg),
          package: delivered,
        },
      };
      return { content: [{ type: 'text', text: JSON.stringify(document) }] };
    },
  );

  server.registerResource(
    'context',
    new ResourceTemplate('boopy://context/{id}', {
      list: async () => {
        const found = boopy.packages().slice(0, 50);
        for (const pkg of found) boopy.disclose(pkg, agent, 'mcp', 'resource-list');
        return {
          resources: found.map((pkg) => ({
            uri: `boopy://context/${pkg.id}`,
            name: pkg.title,
            mimeType: 'text/plain',
          })),
        };
      },
    }),
    {
      title: 'Committed context',
      description:
        'One committed Boopy context package, as text, distinguishing explicit human confirmation from accepted, unconfirmed model proposals.',
      mimeType: 'text/plain',
    },
    async (uri, variables) => {
      const id = String(variables.id);
      const pkg = boopy.package(id);
      if (pkg === undefined) throw new Error(`No context with id ${id}.`);
      boopy.disclose(pkg, agent, 'mcp', 'resource');
      return {
        contents: [
          { uri: uri.href, mimeType: 'text/plain', text: deliveredPackage(boopy, pkg).text },
        ],
      };
    },
  );

  return server;
}

const RecallRequest = z.object({
  packageIds: z.array(z.string().min(1)).min(1).max(10),
  query: z.string().min(1).max(500),
  limit: z.number().int().min(1).max(20).default(5),
});

async function recall(
  boopy: Boopy,
  request: z.infer<typeof RecallRequest>,
  agent: string,
  via: 'rest' | 'mcp',
  semanticRanker?: Pick<NvidiaEmbeddingWorker, 'rank'>,
) {
  const packages = [...new Set(request.packageIds)].map((id) => {
    const pkg = boopy.package(id);
    if (pkg === undefined) throw new BoopyError(404, 'no_package', 'No such committed package.');
    if (pkg.version !== 2)
      throw new BoopyError(409, 'legacy_evidence', 'Selected package lacks versioned evidence.');
    return pkg;
  });
  const records = packages.flatMap(evidenceRecords);
  if (records.length > 500)
    throw new BoopyError(413, 'recall_scope', 'Select at most 500 evidence records.');
  const superseded = new Set(boopy.supersessions.map((link) => evidenceSourceId(link.predecessor)));
  let current = records.filter((record) => !superseded.has(record.sourceId));
  let eligible = current.filter(
    (record) => record.disposition === 'context' || record.disposition === 'intent',
  );
  let semantic: {
    status: 'disabled' | 'available' | 'unavailable';
    provider: 'nvidia';
    model?: string;
    revision?: string;
  } = { status: semanticRanker ? 'unavailable' : 'disabled', provider: 'nvidia' };
  let semanticScores: Map<string, number> | undefined;
  if (semanticRanker && eligible.length > 0 && eligible.length <= 20) {
    try {
      const ranked = await semanticRanker.rank({
        query: request.query,
        candidates: eligible.map((record) => ({
          sourceId: record.sourceId,
          text: [
            record.label,
            record.statement,
            record.gloss ?? '',
            record.note ?? '',
            ...record.text,
          ].join('\n'),
        })),
      });
      const parsed = z
        .object({
          model: z.literal('nvidia/nemotron-3-embed-1b'),
          revision: z.literal('c0c9fea93ea424587517f2c59e20db9f1d6bf615'),
          candidates: z
            .array(
              z
                .object({ sourceId: z.string(), score: z.number().finite().min(-1).max(1) })
                .strict(),
            )
            .max(20),
        })
        .strict()
        .parse(ranked);
      const scores = new Map(
        parsed.candidates.map((candidate) => [candidate.sourceId, candidate.score]),
      );
      if (
        scores.size !== eligible.length ||
        parsed.candidates.length !== eligible.length ||
        eligible.some((record) => !scores.has(record.sourceId))
      )
        throw new Error('Invalid ranking identity');
      semanticScores = scores;
      semantic = {
        status: 'available',
        provider: 'nvidia',
        model: parsed.model,
        revision: parsed.revision,
      };
    } catch {
      /* Preserve lexical results without claiming semantic availability. */
    }
  }
  // An asynchronous rank must not resurrect a source corrected while inference was running.
  const latestSuperseded = new Set(
    boopy.supersessions.map((link) => evidenceSourceId(link.predecessor)),
  );
  current = records.filter((record) => !latestSuperseded.has(record.sourceId));
  eligible = current.filter(
    (record) => record.disposition === 'context' || record.disposition === 'intent',
  );
  if (semanticScores)
    semanticScores = new Map(
      [...semanticScores].filter(([sourceId]) => !latestSuperseded.has(sourceId)),
    );
  const results = new MemoryRecall(eligible).query(request.query, {
    topN: request.limit,
    semanticScores,
  });
  for (const pkg of packages) boopy.disclose(pkg, agent, via, 'recall');
  return {
    type: 'boopy.recall',
    version: 1,
    engine: 'hmem-subset',
    semantic,
    results,
    constraints: current.filter(
      (record) => record.disposition === 'known' || record.disposition === 'rejected',
    ),
    openQuestions: current.filter((record) => record.disposition === 'question'),
    supersededCount: records.length - current.length,
  };
}

/** Overlay later human actions on reads; never rewrite the committed journal snapshot. */
function deliveredPackage(boopy: Boopy, pkg: ContextPackage) {
  const links = boopy.supersessions.filter((link) => link.predecessor.packageId === pkg.id);
  if (links.length === 0) return pkg;
  const records = evidenceRecords(pkg);
  const notices = links.map((link) => {
    const record = records.find((entry) => entry.itemId === link.predecessor.itemId);
    return `- Superseded item ${link.predecessor.itemId} (${record?.label ?? 'unknown'}). Do not use this old claim for a current answer. Fetch successor package ${link.successor.packageId}, item ${link.successor.itemId}. Linking does not confirm the successor.`;
  });
  return {
    ...pkg,
    correctionOverlay: { version: 1, supersessions: links },
    text: `${pkg.text}\n\nLater human corrections (read-time overlay; the saved snapshot above is historical):\n${notices.join('\n')}`,
  };
}
