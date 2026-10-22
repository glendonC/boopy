import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import sharp from 'sharp';
import { Boopy } from './boopy.ts';
import { Grounding } from './contracts.ts';
import {
  MAX_SEGMENT_ITEMS,
  rasterContour,
  SamSegmenter,
  type Segmenter,
  type SegmentInput,
  segmentItems,
} from './segmentation.ts';
import { startRequest, testBoopy } from './testing.ts';

// Synthetic 12×10 staircase trapezoid, encoded once by the verified parser's conformance
// encoder. It is not a real camera capture. The source frame is 100×80, cropped at (10,20).
const payload = '!!!!!)y:1+u_%Vt';
const record = (id = 0, left = 10, sourceWidth = 100) =>
  `${id}<|box;x1=${left};y1=20;x2=${left + 11};y2=29;w=${sourceWidth};h=80|>` +
  `<|mask;x=0;y=0;data=10,12,${payload}|>`;

function stream(text: string, options: { complete?: boolean; split?: boolean } = {}): Response {
  const lane = { item_id: 'test', output_index: 0, content_index: 0 };
  const events = [
    { type: 'response.output_text.delta', delta: text, ...lane },
    { type: 'response.output_text.done', text, ...lane },
    ...(options.complete === false ? [] : [{ type: 'response.completed' }]),
  ];
  const bytes = new TextEncoder().encode(
    events.map((e) => `data: ${JSON.stringify(e)}\r\n\r\n`).join(''),
  );
  return new Response(
    new ReadableStream({
      start(controller) {
        const size = options.split ? 7 : bytes.length;
        for (let i = 0; i < bytes.length; i += size) controller.enqueue(bytes.slice(i, i + size));
        controller.close();
      },
    }),
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
}

const image = await sharp({
  create: { width: 100, height: 80, channels: 3, background: '#eeeeee' },
})
  .jpeg()
  .toBuffer();
const input: SegmentInput = {
  image,
  width: 100,
  height: 80,
  concept: 'red rectangle',
  box: { x0: 0.1, y0: 0.25, x1: 0.22, y1: 0.375 },
  focus: { x: 0.15, y: 0.3 },
};
const adapter = (response: () => Response) =>
  new SamSegmenter({
    apiKey: 'synthetic-secret',
    fetch: async () => response(),
  });

describe('hosted segmentation adapter', () => {
  it('uses the exact standard model, raw frame and one-bit Responses schema', async () => {
    let called = false;
    const segmenter = new SamSegmenter({
      apiKey: 'synthetic-secret',
      fetch: async (url, init) => {
        called = true;
        assert.equal(url, 'https://api.meta.ai/v1/responses');
        assert.equal(
          (init?.headers as Record<string, string> | undefined)?.Authorization,
          'Bearer synthetic-secret',
        );
        const body = JSON.parse(String(init?.body));
        assert.equal(body.model, 'sam-3.1');
        assert.equal(body.stream, true);
        assert.deepEqual(body.metadata, { mask_encoding: 'one_bit' });
        assert.equal(body.input[0].content[0].text, input.concept);
        assert.equal(
          body.input[0].content[1].image_url,
          `data:image/jpeg;base64,${image.toString('base64')}`,
        );
        assert.equal(body.input[0].content.length, 2);
        return stream(`<0f>${record()}\n`, { split: true });
      },
    });
    const result = await segmenter.segment(input);
    assert.equal(called, true);
    assert.equal(result.outcome, 'contour');
    assert.equal(result.confidence, null, 'absence is not fabricated confidence');
    assert.ok(result.mask !== undefined);
    assert.ok(result.contour !== undefined && result.contour.length >= 3);
    assert.ok(
      result.contour.every((p) => p.x >= 0.1 && p.x <= 0.22 && p.y >= 0.25 && p.y <= 0.375),
    );
    assert.ok(
      result.contour.some((p) => p.x > 0.1 && p.y === 0.375),
      'slope survives; this is not a box',
    );
    assert.ok(
      Grounding.safeParse({ kind: 'box', box: input.box, contour: result.contour }).success,
    );
  });

  it('treats empty completed output and an off-cue match as no-match', async () => {
    assert.equal((await adapter(() => stream('')).segment(input)).outcome, 'no-match');
    assert.equal(
      (
        await adapter(() => stream(`<0f>${record()}\n`)).segment({
          ...input,
          focus: { x: 0.1, y: 0.37 },
        })
      ).outcome,
      'no-match',
    );
  });

  it('refuses to pick between overlapping instances at the cue', async () => {
    const result = await adapter(() => stream(`<0f>${record()},${record(1)}\n`)).segment(input);
    assert.equal(result.outcome, 'ambiguous');
    assert.equal(result.contour, undefined);
  });

  it('rejects incomplete, malformed, oversized and source-mismatched masks', async () => {
    const outputs = [
      stream(`<0f>${record()}\n`, { complete: false }),
      stream(`<0f>${record().replace(payload, '!broken')}\n`),
      stream(`<0f>${record().replace('data=10,12', 'data=5000,5000')}\n`),
      stream(`<0f>${record().replace('mask;x=0', 'mask;x=1')}\n`),
      stream(`<0f>${record(0, 10, 200)}\n`),
      stream(`<0f>${record()},${record(1, 90)}\n`),
      stream('Unstructured prose is not geometry.'),
    ];
    for (const response of outputs) {
      const result = await adapter(() => response).segment(input);
      assert.equal(result.outcome, 'failed');
      assert.equal(result.contour, undefined);
    }
  });
  it('guards raster allocation when Meta finalizes a content part without deltas', async () => {
    const partResponse = (text: string) =>
      new Response(
        [
          {
            type: 'response.content_part.done',
            item_id: 'test',
            output_index: 0,
            content_index: 0,
            part: { type: 'output_text', text },
          },
          { type: 'response.completed' },
        ]
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join(''),
      );
    assert.equal(
      (await adapter(() => partResponse(`<0f>${record()}\n`)).segment(input)).outcome,
      'contour',
    );
    // Impossible dimensions are refused before the official parser can allocate the raster.
    assert.equal(
      (
        await adapter(() =>
          partResponse(`<0f>${record().replace('data=10,12', 'data=999999999,999999999')}\n`),
        ).segment(input)
      ).outcome,
      'failed',
    );
  });

  it('sanitizes HTTP and transport errors and bounds the request timeout', async () => {
    const missing = await adapter(() => new Response('private content', { status: 404 })).segment(
      input,
    );
    assert.equal(missing.outcome, 'failed');
    const broken = await new SamSegmenter({
      apiKey: 'synthetic-secret',
      fetch: async () => {
        throw new Error('Bearer synthetic-secret private content');
      },
    }).segment(input);
    assert.equal(broken.outcome, 'failed');
    assert.ok(!JSON.stringify(broken).includes('synthetic-secret'));
    const timeout = new SamSegmenter({
      apiKey: 'synthetic-secret',
      timeoutMs: 5,
      fetch: async (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('timeout')), {
            once: true,
          });
          // Keep the test alive; AbortSignal.timeout itself deliberately does not retain Node.
          setTimeout(() => reject(new Error('test deadline')), 20);
        }),
    });
    assert.equal((await timeout.segment(input)).outcome, 'failed');
  });

  it('checks real dimensions before transmitting any content', async () => {
    let calls = 0;
    const segmenter = new SamSegmenter({
      apiKey: 'synthetic-secret',
      fetch: async () => {
        calls++;
        return stream('');
      },
    });
    assert.equal((await segmenter.segment({ ...input, width: 101 })).outcome, 'failed');
    assert.equal(
      (await segmenter.segment({ ...input, width: 10000, height: 10000 })).outcome,
      'failed',
    );
    assert.equal(calls, 0);
  });
});

describe('contour geometry', () => {
  it('keeps the concave outline of an L shape and caps the ordered points', () => {
    const width = 40,
      height = 40;
    const raster = Uint8Array.from({ length: width * height }, (_, i) =>
      i % width < 12 || Math.floor(i / width) > 27 ? 1 : 0,
    );
    const contour = rasterContour(raster, width, height);
    assert.ok(contour.length >= 6 && contour.length <= 256);
    assert.ok(contour.some((p) => p.x === 12 && p.y === 28));
    assert.notDeepEqual(contour[0], contour.at(-1));
  });
  it('refuses holes, disconnected regions and invalid dimensions rather than false fill', () => {
    assert.throws(() => rasterContour(Uint8Array.from([1, 1, 1, 1, 0, 1, 1, 1, 1]), 3, 3));
    assert.throws(() => rasterContour(Uint8Array.from([1, 0, 0, 0, 0, 0, 0, 0, 1]), 3, 3));
    assert.throws(() => rasterContour(new Uint8Array(3), 2, 2));
  });
  it('omits only tiny segmentation specks while keeping the exact source mask separately', () => {
    const width = 25,
      height = 25;
    const raster = Uint8Array.from({ length: width * height }, (_, i) => {
      const x = i % width,
        y = Math.floor(i / width);
      return (x < 20 && y < 20) || (x === 24 && y === 24) ? 1 : 0;
    });
    const contour = rasterContour(raster, width, height);
    assert.ok(contour.every((p) => p.x <= 20 && p.y <= 20));
    assert.equal(raster[24 * width + 24], 1, 'never alters the original binary mask');
  });
});

describe('bounded multiple-object segmentation', () => {
  it('shares one concept request across distinct matching instances and retains exact concept provenance', async () => {
    let calls = 0;
    const segmenter = new SamSegmenter({
      apiKey: 'synthetic-secret',
      fetch: async (_url, init) => {
        calls++;
        const body = JSON.parse(String(init?.body));
        assert.equal(body.input[0].content[0].text, 'red rectangle');
        return stream(`<0f>${record()},${record(1, 50)}\n`);
      },
    });
    const results = await segmentItems(segmenter, [
      input,
      {
        ...input,
        concept: 'Red rectangle',
        focus: null,
        box: { x0: 0.5, y0: 0.25, x1: 0.62, y1: 0.375 },
      },
    ]);
    assert.equal(calls, 1);
    assert.deepEqual(
      results.map((r) => r.outcome),
      ['contour', 'contour'],
    );
    assert.deepEqual(
      results.map((r) => r.concept),
      ['red rectangle', 'red rectangle'],
    );
    assert.ok(results[0]?.contour?.every((point) => point.x <= 0.22));
    assert.ok(results[1]?.contour?.every((point) => point.x >= 0.5));
    assert.ok(!results[0]?.mask?.equals(results[1]?.mask ?? Buffer.alloc(0)));
  });
  it('does not assign the same response-local instance to two distinct semantic objects', async () => {
    const results = await segmentItems(
      adapter(() => stream(`<0f>${record()}\n`)),
      [input, { ...input, focus: null }],
    );
    assert.deepEqual(
      results.map((r) => r.outcome),
      ['ambiguous', 'ambiguous'],
    );
    assert.ok(results.every((r) => r.contour === undefined && r.mask === undefined));
  });
  it('bounds capture item count and hosted concurrency without combining concepts', async () => {
    let active = 0,
      peak = 0,
      calls = 0;
    const segmenter = new SamSegmenter({
      apiKey: 'synthetic-secret',
      fetch: async (_url, init) => {
        active++;
        peak = Math.max(peak, active);
        calls++;
        const body = JSON.parse(String(init?.body));
        assert.equal(
          body.input[0].content.filter((part: { type: string }) => part.type === 'input_text')
            .length,
          1,
        );
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        return stream('');
      },
    });
    const results = await segmentItems(
      segmenter,
      Array.from({ length: 9 }, (_, i) => ({ ...input, concept: `object ${i}` })),
    );
    assert.equal(results.length, MAX_SEGMENT_ITEMS);
    assert.equal(calls, 4);
    assert.equal(peak, 2);
  });
  it('keeps completed contours when another concept exceeds the shared deadline, and stops queued work', async () => {
    let calls = 0,
      aborted = false;
    const segmenter: Segmenter = {
      provider: 'meta',
      model: 'sam-3.1',
      segment: async (target, signal) => {
        calls++;
        if (target.concept === 'fast')
          return {
            outcome: 'contour',
            latencyMs: 1,
            confidence: null,
            contour: [
              { x: 0.1, y: 0.1 },
              { x: 0.2, y: 0.1 },
              { x: 0.2, y: 0.2 },
            ],
          };
        signal?.addEventListener(
          'abort',
          () => {
            aborted = true;
          },
          { once: true },
        );
        return await new Promise<never>(() => {});
      },
    };
    const results = await segmentItems(
      segmenter,
      ['fast', 'slow', 'slow again', 'never starts'].map((concept) => ({ ...input, concept })),
      15,
    );
    assert.equal(results[0]?.outcome, 'contour');
    assert.ok(results.slice(1).every((r) => r.outcome === 'failed' && r.confidence === null));
    assert.equal(calls, 3, 'two workers, then first completed worker starts one queued request');
    assert.equal(aborted, true);
  });
});
