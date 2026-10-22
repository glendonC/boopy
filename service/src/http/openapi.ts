/**
 * The connector's REST API as OpenAPI 3.1, for agents that build clients from a spec (Meta
 * documents neither way for Muse custom connectors, so Boopy offers this and MCP).
 */
export function openApiDocument(baseUrl: string, memory = false) {
  const errorBody = {
    type: 'object',
    properties: {
      error: {
        type: 'object',
        properties: { code: { type: 'string' }, message: { type: 'string' } },
      },
    },
  };
  return {
    openapi: '3.1.0',
    info: {
      title: 'Boopy committed context',
      version: '0.1.0',
      description:
        'Read-only access to context the user saved about their physical world. Each claim has a verification label: confirmed, corrected, added by the user, or accepted (proposed by a model and left uncorrected, not individually confirmed). Saving does not establish that every item was reviewed or confirmed.',
    },
    servers: [{ url: baseUrl }],
    security: [{ bearer: [] }],
    components: {
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
    },
    paths: {
      ...(memory
        ? {
            '/v1/recall': {
              post: {
                operationId: 'recallEvidence',
                summary: 'Local H-MEM subset recall over explicitly selected version-2 packages',
                requestBody: {
                  required: true,
                  content: {
                    'application/json': {
                      schema: {
                        type: 'object',
                        required: ['packageIds', 'query'],
                        properties: {
                          packageIds: {
                            type: 'array',
                            minItems: 1,
                            maxItems: 10,
                            items: { type: 'string' },
                          },
                          query: { type: 'string', minLength: 1, maxLength: 500 },
                          limit: { type: 'integer', minimum: 1, maximum: 20, default: 5 },
                        },
                      },
                    },
                  },
                },
                responses: {
                  '200': {
                    description:
                      'Ranked current context and intent, separate known/rejected constraints and open questions. All preserve verification and source IDs; ranking is not factual confidence. Optional local NVIDIA cosine replaces only the H-MEM semantic component for at most 20 eligible sources; semantic status reports disabled, available with model/revision, or unavailable with lexical fallback. No vectors are returned.',
                  },
                  '401': { description: 'Missing or wrong bearer token' },
                  '404': { description: 'No such committed package' },
                  '409': { description: 'Selected legacy package lacks versioned evidence' },
                  '413': { description: 'Selection exceeds 500 records' },
                },
              },
            },
          }
        : {}),
      '/v1/context': {
        get: {
          operationId: 'searchContext',
          summary: 'Search committed context; an empty query returns the most recent',
          parameters: [
            {
              name: 'query',
              in: 'query',
              required: false,
              schema: { type: 'string' },
              description: 'Words to look for. Empty returns the most recent.',
            },
            {
              name: 'limit',
              in: 'query',
              required: false,
              schema: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
            },
          ],
          responses: {
            '200': {
              description: 'Matching context packages',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      results: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            id: { type: 'string' },
                            title: { type: 'string' },
                            committedAt: { type: 'string', format: 'date-time' },
                            summary: { type: 'string' },
                            url: { type: 'string' },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            '401': {
              description: 'Missing or wrong token',
              content: { 'application/json': { schema: errorBody } },
            },
          },
        },
      },
      '/v1/context/{id}': {
        get: {
          operationId: 'getContext',
          summary: 'One context package, with a plain-text rendering in its text field',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': {
              description:
                'Committed snapshot with a read-time correctionOverlay and text warning when later human supersession links exist. Do not use superseded claims for current answers; fetch the indicated successor. Stored snapshots remain unchanged.',
              content: { 'application/json': { schema: { type: 'object' } } },
            },
            '401': {
              description: 'Missing or wrong token',
              content: { 'application/json': { schema: errorBody } },
            },
            '404': {
              description: 'No such context',
              content: { 'application/json': { schema: errorBody } },
            },
          },
        },
      },
    },
  };
}
