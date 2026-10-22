/**
 * Drives a whole session through the running service, the way the headset does, then reads the
 * committed context back over MCP as an agent would. Writes a preview of the model's grounding
 * on the frame to .build/ so it can be checked by eye.
 *
 *   pnpm start                       # in one terminal
 *   pnpm simulate                    # in another; the desert scenario
 *   pnpm simulate --image fixtures/images/korean-notes.jpg --say "Help me study this" --gaze 0.4,0.4
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import sharp from 'sharp';
import { type Cues, type Item, SessionView, type StartSessionRequest } from '../contracts.ts';

const { values } = parseArgs({
  options: {
    image: { type: 'string', default: 'fixtures/images/desert-photo.jpg' },
    say: { type: 'string', default: 'I want to practice talking about this trip in Korean.' },
    gaze: { type: 'string', default: '0.45,0.5' },
    pointer: { type: 'string' },
    headset: { type: 'string', default: 'http://127.0.0.1:47900' },
    connector: { type: 'string', default: 'http://127.0.0.1:47901' },
    corrections: { type: 'boolean', default: true },
  },
});

const point = (text: string | undefined) => {
  if (text === undefined) return undefined;
  const [x, y] = text.split(',').map(Number);
  if (x === undefined || y === undefined || Number.isNaN(x) || Number.isNaN(y)) {
    throw new Error(`Expected x,y between 0 and 1, got ${text}`);
  }
  return { point: { x, y }, onSurface: true };
};

async function call(path: string, body?: unknown): Promise<SessionView> {
  const response = await fetch(`${values.headset}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const answer = await response.json();
  if (!response.ok)
    throw new Error(`${path} answered ${response.status}: ${JSON.stringify(answer)}`);
  return SessionView.parse(answer);
}

function show(view: SessionView): void {
  console.log(`  notice: ${view.notice}`);
  for (const item of view.items) {
    const mark =
      item.id === view.referentId ? ' (referent)' : item.id === view.intentId ? ' (intent)' : '';
    const where = item.grounding.kind;
    const confidence = item.confidence === null ? '' : ` ${item.confidence.toFixed(2)}`;
    const gloss = item.gloss === undefined ? '' : ` [${item.gloss}]`;
    console.log(
      `  ${item.status.padEnd(9)} ${item.kind.padEnd(10)} ${where.padEnd(5)}${confidence} ${item.label}${gloss}${mark}`,
    );
  }
}

const jpeg = readFileSync(values.image);
const { width = 0, height = 0 } = await sharp(jpeg).metadata();
const gaze = point(values.gaze);
const pointer = point(values.pointer);
const cues: Cues = {
  ...(gaze !== undefined && { gaze }),
  ...(pointer !== undefined && { pointer: { ...pointer, hand: 'right' as const } }),
};
const request: StartSessionRequest = {
  frame: { jpeg: jpeg.toString('base64'), width, height, capturedAt: new Date().toISOString() },
  cues,
  speech: { text: values.say },
  device: { model: 'simulated headset', app: 'pnpm simulate' },
};

console.log(`Asking: "${values.say}" about ${values.image}`);
const started = performance.now();
let view = await call('/v1/sessions', request);
if (
  view.model === null ||
  !view.items.some((item) => item.origin === 'model' && item.status === 'proposed')
) {
  throw new Error(`Initial interpretation failed: ${view.notice ?? 'No model proposal returned.'}`);
}
console.log(
  `Interpreted by ${view.model.provider}:${view.model.id} in ${view.model.latencyMs} ms (round trip ${Math.round(performance.now() - started)} ms)`,
);
show(view);
await preview(view);

if (values.corrections) {
  const pick = (test: (item: Item) => boolean) =>
    view.items.find(
      (item) =>
        item.status === 'proposed' &&
        item.id !== view.intentId &&
        item.id !== view.referentId &&
        test(item),
    );
  const object = pick((item) => item.kind === 'object');
  if (object !== undefined) {
    view = await call(`/v1/sessions/${view.id}/utterances`, {
      speech: { text: "Not that, it isn't part of the trip" },
      cues: { targetItemId: object.id },
    });
  }
  const word = pick((item) => item.kind === 'vocabulary');
  if (word !== undefined) {
    view = await call(`/v1/sessions/${view.id}/utterances`, {
      speech: { text: 'I already know this' },
      cues: { targetItemId: word.id },
    });
  }
  const topic = pick(
    (item) => item.kind === 'topic' || item.kind === 'grammar' || item.kind === 'goal',
  );
  if (topic !== undefined) {
    view = await call(`/v1/sessions/${view.id}/actions`, { itemId: topic.id, action: 'matters' });
  }
  view = await call(`/v1/sessions/${view.id}/utterances`, {
    speech: { text: 'I also want to talk about the sunset' },
  });
  console.log('After corrections:');
  show(view);
}

view = await call(`/v1/sessions/${view.id}/utterances`, { speech: { text: 'Save it' } });
console.log(`Committed ${view.committed?.packageId}: ${view.committed?.summary}`);

const token = readFileSync(
  join(process.env.BOOPY_DATA_DIR ?? join(homedir(), '.boopy'), 'connector-token'),
  'utf8',
).trim();
const client = new Client(
  { name: 'boopy-simulate', version: '0.1.0' },
  { versionNegotiation: { mode: 'auto' } },
);
await client.connect(
  new StreamableHTTPClientTransport(new URL(`${values.connector}/mcp`), {
    requestInit: {
      headers: { authorization: `Bearer ${token}`, 'x-boopy-agent': 'pnpm simulate' },
    },
  }),
);
const fetched = await client.callTool({
  name: 'fetch',
  arguments: { id: view.committed?.packageId ?? '' },
});
const protocol = client.getNegotiatedProtocolVersion();
await client.close();
const document = JSON.parse((fetched.content[0] as { text: string }).text) as { text: string };
console.log(`\nWhat an agent reads over MCP (protocol ${protocol}):\n`);
console.log(document.text);

/** Draws each grounded box and point on the frame, labelled, so grounding can be judged by eye. */
async function preview(session: SessionView): Promise<void> {
  const shapes = session.items.flatMap((item) => {
    const g = item.grounding;
    const colour = item.id === session.referentId ? '#00e676' : '#ffd600';
    const label = item.label.replace(/[<>&"]/g, '');
    if (g.kind === 'box' && g.box !== undefined) {
      const x = g.box.x0 * width;
      const y = g.box.y0 * height;
      return [
        `<rect x="${x}" y="${y}" width="${(g.box.x1 - g.box.x0) * width}" height="${(g.box.y1 - g.box.y0) * height}" fill="none" stroke="${colour}" stroke-width="3"/>`,
        `<text x="${x + 4}" y="${y + 20}" font-family="Helvetica" font-size="18" fill="${colour}" stroke="#000" stroke-width="3" paint-order="stroke">${label}</text>`,
      ];
    }
    if (g.kind === 'point' && g.point !== undefined) {
      const x = g.point.x * width;
      const y = g.point.y * height;
      return [
        `<circle cx="${x}" cy="${y}" r="8" fill="${colour}"/>`,
        `<text x="${x + 12}" y="${y + 6}" font-family="Helvetica" font-size="18" fill="${colour}" stroke="#000" stroke-width="3" paint-order="stroke">${label}</text>`,
      ];
    }
    return [];
  });
  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">${shapes.join('')}</svg>`;
  const output = join('.build', `preview-${session.id}.jpg`);
  writeFileSync(
    output,
    await sharp(jpeg)
      .composite([{ input: Buffer.from(svg) }])
      .jpeg()
      .toBuffer(),
  );
  console.log(`  grounding preview: ${output}`);
}
