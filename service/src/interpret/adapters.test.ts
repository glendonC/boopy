import assert from 'node:assert/strict';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { FixtureInterpreter } from './fixture.ts';
import type { InterpretInput } from './interpreter.ts';
import { MuseSparkInterpreter } from './muse-spark.ts';
import { OllamaInterpreter } from './ollama.ts';
import { InterpretError } from './output.ts';

/** A stand-in model server that records each request and answers what the test sets. */
class StubServer {
  readonly server: Server;
  requests: { url: string; headers: IncomingHttpHeaders; body: Record<string, unknown> }[] = [];
  status = 200;
  answer: unknown = {};
  /** Answers given in order before falling back to status and answer. */
  queue: { status: number; answer: unknown }[] = [];

  constructor() {
    this.server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        this.requests.push({
          url: request.url ?? '',
          headers: request.headers,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
        });
        const next = this.queue.shift() ?? { status: this.status, answer: this.answer };
        response.writeHead(next.status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(next.answer));
      });
    });
  }

  get url(): string {
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
}

const input: InterpretInput = {
  said: 'What is this?',
  language: 'en',
  scope: 'auto',
  gaze: { x: 0.5, y: 0.5 },
  pointer: null,
  image: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
  crop: {
    image: Buffer.from([0xff, 0xd8, 0x00, 0xff, 0xd9]),
    region: { x0: 0.2, y0: 0.2, x1: 0.8, y1: 0.8 },
  },
  text: [],
  decisions: [{ label: 'Tents', status: 'rejected', note: "we didn't camp" }],
};

const recorded = (await new FixtureInterpreter().interpret(input)).output;

describe('model adapters', () => {
  const stub = new StubServer();
  before(() => new Promise<void>((resolve) => stub.server.listen(0, '127.0.0.1', resolve)));
  after(() => new Promise<void>((resolve) => stub.server.close(() => resolve())));

  it("asks Ollama with both images, the strict schema and the person's decisions", async () => {
    stub.status = 200;
    stub.answer = { message: { role: 'assistant', content: JSON.stringify(recorded) } };
    const ollama = new OllamaInterpreter({ url: stub.url, model: 'muse-glimmer:30b-mlx' });
    const result = await ollama.interpret(input);
    const sent = stub.requests.at(-1);
    assert.ok(sent);
    assert.equal(sent.url, '/api/chat');
    assert.equal(sent.body.model, 'muse-glimmer:30b-mlx');
    assert.equal(sent.body.stream, false);
    assert.equal((sent.body.format as { type: string }).type, 'object');
    const messages = sent.body.messages as { role: string; content: string; images?: string[] }[];
    assert.equal(messages[0]?.role, 'system');
    assert.equal(messages[1]?.images?.length, 2);
    assert.match(messages[1]?.content ?? '', /Tents: rejected \(we didn't camp\)/);
    assert.match(messages[1]?.content ?? '', /G \(head direction\) is at \[500, 500\]/);
    assert.equal(result.output.items.length, recorded.items.length);
  });

  it('falls back to the schema in the prompt when the model cannot do structured output', async () => {
    stub.queue = [
      { status: 501, answer: { error: 'structured output is unavailable' } },
      {
        status: 200,
        answer: { message: { content: `\`\`\`json\n${JSON.stringify(recorded)}\n\`\`\`` } },
      },
      { status: 200, answer: { message: { content: JSON.stringify(recorded) } } },
    ];
    const ollama = new OllamaInterpreter({ url: stub.url, model: 'qwen3.6:35b-a3b-nvfp4' });
    const before = stub.requests.length;
    const result = await ollama.interpret(input);
    assert.equal(result.output.items.length, recorded.items.length);
    const [refused, retried] = stub.requests.slice(before);
    assert.ok(refused?.body.format);
    assert.equal(retried?.body.format, undefined);
    const system =
      (retried?.body.messages as { content: string }[] | undefined)?.[0]?.content ?? '';
    assert.match(system, /matches this JSON Schema exactly/);
    await ollama.interpret(input);
    assert.equal(stub.requests.at(-1)?.body.format, undefined, 'remembers the model cannot');
  });

  it('asks Muse Spark through Chat Completions with strict JSON Schema and a bearer key', async () => {
    stub.answer = { choices: [{ message: { content: JSON.stringify(recorded) } }] };
    const spark = new MuseSparkInterpreter({ apiKey: 'test-key', baseUrl: `${stub.url}/v1` });
    await spark.interpret(input);
    const sent = stub.requests.at(-1);
    assert.ok(sent);
    assert.equal(sent.url, '/v1/chat/completions');
    assert.equal(sent.headers.authorization, 'Bearer test-key');
    assert.equal(sent.body.model, 'muse-spark-1.3');
    assert.equal(sent.body.reasoning_effort, 'minimal');
    const format = sent.body.response_format as { json_schema: { strict: boolean } };
    assert.equal(format.json_schema.strict, true);
    const content = (sent.body.messages as { content: unknown }[])[1]?.content as {
      type: string;
      image_url?: { url: string };
    }[];
    assert.equal(content.filter((part) => part.type === 'image_url').length, 2);
    assert.match(content[1]?.image_url?.url ?? '', /^data:image\/jpeg;base64,/);
  });

  it('refuses Contributor-tier models, which train on prompts', () => {
    assert.throws(
      () => new MuseSparkInterpreter({ apiKey: 'k', model: 'muse-spark-1.3-contributor' }),
      /trains on prompts/,
    );
  });

  it('reports a provider error with its status', async () => {
    stub.status = 429;
    stub.answer = { error: 'rate limited' };
    const spark = new MuseSparkInterpreter({ apiKey: 'k', baseUrl: `${stub.url}/v1` });
    await assert.rejects(spark.interpret(input), (error: unknown) => {
      return error instanceof InterpretError && error.message.includes('429');
    });
  });
});
