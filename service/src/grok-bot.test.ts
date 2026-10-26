import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import sharp from 'sharp';
import {
  deliver,
  type GrokBotLink,
  GrokBotMoments,
  loadGrokBot,
  type Moment,
  momentMessage,
  momentPicture,
  webhookSignature,
} from './grok-bot.ts';
import { Journal } from './journal.ts';

/** A local stand-in for the Bot's webhook: it keeps what came in and answers as told. */
async function receiver(status: number, reply: unknown) {
  const received: { headers: IncomingHttpHeaders; body: string }[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      received.push({ headers: request.headers, body });
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(reply));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/automations/webhook/r1`;
  return { url, received, close: () => new Promise((resolve) => server.close(resolve)) };
}

const frame = () =>
  sharp({ create: { width: 640, height: 480, channels: 3, background: '#7a8a6a' } })
    .jpeg()
    .toBuffer();

const moment = async (over: Partial<Moment> = {}): Promise<Moment> => ({
  momentId: 'mom_camel_1',
  attempt: 0,
  taskId: 'tsk_camel_1',
  sessionId: 'ses_camel',
  subject: 'camel',
  term: { text: '낙타', language: 'ko', languageName: 'Korean' },
  heard: null,
  memory: null,
  recorded: true,
  pointed: false,
  picture: await momentPicture(
    await frame(),
    { x: 0.8, y: 0.4 },
    { x0: 0.7, y0: 0.3, x1: 0.9, y1: 0.5 },
  ),
  ...over,
});

test('a moment goes once to the Bot with a Bearer key, and only a started run counts as sent', async () => {
  const bot = await receiver(200, { success: true, runUuid: 'run-0001' });
  const journal = Journal.open(':memory:');
  const link: GrokBotLink = {
    url: bot.url,
    auth: 'bearer',
    key: 'crsr_synthetic',
    timeoutMs: 2000,
  };
  const moments = new GrokBotMoments(journal, link);
  try {
    assert.equal(moments.started('tsk_camel_1'), false);
    assert.deepEqual(await moments.send(await moment()), {
      outcome: 'started',
      runUuid: 'run-0001',
    });
    assert.equal(await moments.send(await moment()), null);
    assert.equal(bot.received.length, 1);
    const [first] = bot.received;
    assert.equal(first?.headers.authorization, 'Bearer crsr_synthetic');
    const body = JSON.parse(first?.body ?? '');
    assert.deepEqual(
      { ...body, image: undefined },
      {
        source: 'Boopy',
        kind: 'moment',
        momentId: 'mom_camel_1',
        message:
          'From my Boopy headset: I looked at something in my trip footage, and Boopy thought it was a camel. Boopy gave the Korean word 낙타 (Wikidata via Zetaris).',
        subject: 'camel',
        term: { text: '낙타', language: 'ko', source: 'Wikidata via Zetaris' },
        heard: null,
        memory: null,
        recorded: true,
        image: undefined,
      },
    );
    assert.equal(body.image.mediaType, 'image/jpeg');
    // The view around the gaze, small enough to send, with no capture metadata.
    const image = Buffer.from(body.image.base64, 'base64');
    const shape = await sharp(image).metadata();
    assert.ok(image.length <= 40_000 && shape.format === 'jpeg' && (shape.width ?? 0) <= 480);
    assert.equal(shape.exif, undefined);
    assert.equal(moments.started('tsk_camel_1'), true);
    const started = journal.all().filter((event) => event.type.startsWith('grokbot.'));
    assert.deepEqual(
      started.map((event) => [event.type, event.data]),
      [
        [
          'grokbot.delivery.started',
          { momentId: 'mom_camel_1', attempt: 0, taskId: 'tsk_camel_1', runUuid: 'run-0001' },
        ],
      ],
    );

    // The answer goes under the same moment, with what Boopy heard and no second picture.
    await moments.send(await moment({ attempt: 1, heard: true, picture: null }));
    assert.equal(bot.received.length, 2);
    const second = JSON.parse(bot.received[1]?.body ?? '');
    assert.equal(second.momentId, 'mom_camel_1');
    assert.equal(second.heard, true);
    assert.equal(second.image, undefined);
    assert.match(second.message, /word 낙타 \(Wikidata via Zetaris\) and heard me say it\.$/);
    // A boop made by pointing alone says so.
    assert.match(
      momentMessage(await moment({ pointed: true })),
      /^From my Boopy headset: I pointed at /,
    );
    assert.ok(
      !JSON.stringify(started).includes('crsr_') &&
        !JSON.stringify(started).includes('/automations/'),
    );
  } finally {
    await bot.close();
  }

  // A refused key starts no run: the failure keeps its status, and the task is not sent.
  const refusing = await receiver(401, { success: false });
  const failing = new GrokBotMoments(journal, { ...link, url: refusing.url });
  try {
    const answered = await moment({ momentId: 'mom_dune_1', taskId: 'tsk_dune_1', heard: false });
    assert.deepEqual(await failing.send(answered), { outcome: 'failed', status: 401 });
    assert.equal(failing.started('tsk_dune_1'), false);
  } finally {
    await refusing.close();
  }
});

test('a whsec_ secret signs the body as Standard Webhooks does', async () => {
  // The example vector from the Standard Webhooks specification.
  assert.equal(
    webhookSignature(
      'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw',
      'msg_p5jXN8AQM9LWM0D4loKWxJek',
      1614265330,
      '{"test": 2432232314}',
    ),
    'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=',
  );
  const bot = await receiver(202, {});
  try {
    const secret = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
    const sent = await deliver(
      { url: bot.url, auth: 'signature', key: secret, timeoutMs: 2000 },
      '{"kind":"moment"}',
      1_700_000_000_000,
    );
    assert.deepEqual(sent, { outcome: 'started', runUuid: null });
    const headers = bot.received[0]?.headers ?? {};
    assert.equal(headers.authorization, undefined);
    assert.equal(headers['webhook-timestamp'], '1700000000');
    assert.equal(
      headers['webhook-signature'],
      webhookSignature(secret, String(headers['webhook-id']), 1_700_000_000, '{"kind":"moment"}'),
    );
  } finally {
    await bot.close();
  }
});

test('the webhook file must be private, name an https URL, and hold a known kind of key', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'boopy-grok-bot-'));
  try {
    const file = join(folder, 'webhook.json');
    const write = async (value: unknown, mode: number) => {
      await writeFile(file, JSON.stringify(value));
      await chmod(file, mode);
    };
    await write(
      { url: 'https://bot.example.invalid/automations/webhook/r1', key: 'crsr_synthetic' },
      0o644,
    );
    await assert.rejects(loadGrokBot(file), /only you can read/);
    await write({ url: 'http://bot.example.invalid/hook', key: 'crsr_synthetic' }, 0o600);
    await assert.rejects(loadGrokBot(file), /must use https/);
    await write({ url: 'https://bot.example.invalid/hook', key: 'sk_synthetic' }, 0o600);
    await assert.rejects(loadGrokBot(file), /crsr_ or whsec_/);
    await write({ url: 'https://bot.example.invalid/hook', key: 'whsec_c3ludGhldGlj' }, 0o600);
    assert.deepEqual(await loadGrokBot(file), {
      url: 'https://bot.example.invalid/hook',
      auth: 'signature',
      key: 'whsec_c3ludGhldGlj',
      timeoutMs: 10_000,
    });
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
