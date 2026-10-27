import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import sharp from 'sharp';
import { gazeView } from './evidence.ts';
import {
  deliver,
  type GrokBotLink,
  GrokBotMoments,
  loadGrokBot,
  type Moment,
  momentMessage,
  momentPicture,
  type PictureSource,
  webhookSignature,
  wholeJpeg,
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
  picture: { jpeg: await frame(), center: { x: 0.8, y: 0.4 }, mark: { ring: { x: 0.8, y: 0.4 } } },
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
    assert.ok(shape.format === 'jpeg' && (shape.width ?? 0) <= 480);
    assert.equal(shape.exif, undefined);
    assert.equal(moments.started('tsk_camel_1'), true);
    const started = journal.all().filter((event) => event.type.startsWith('grokbot.'));
    // The journal keeps the picture's size and the body's, never the picture.
    assert.deepEqual(
      started.map((event) => [event.type, event.data]),
      [
        [
          'grokbot.delivery.started',
          {
            momentId: 'mom_camel_1',
            attempt: 0,
            taskId: 'tsk_camel_1',
            runUuid: 'run-0001',
            pictureBytes: image.length,
            bodyBytes: Buffer.byteLength(first?.body ?? ''),
          },
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

/** How bright the picture is at a frame point, read back through the same gaze view. */
async function brightness(
  picture: Buffer,
  frameJpeg: Buffer,
  center: { x: number; y: number },
  at: { x: number; y: number },
) {
  const { region } = await gazeView(frameJpeg, center);
  const { data, info } = await sharp(picture).raw().toBuffer({ resolveWithObject: true });
  const x = Math.round(((at.x - region.x0) / (region.x1 - region.x0)) * (info.width - 1));
  const y = Math.round(((at.y - region.y0) / (region.y1 - region.y0)) * (info.height - 1));
  const i = (y * info.width + x) * info.channels;
  return ((data[i] ?? 0) + (data[i + 1] ?? 0) + (data[i + 2] ?? 0)) / 3;
}

test('the picture marks the subject by its outline, or by a ring at the point, never by a box', async () => {
  const jpeg = await frame();
  const gaze = { x: 0.5, y: 0.5 };
  // A subject with only the model's loose box: a ring at the gaze, and nothing on the box's edge.
  const ringed = await picture({ jpeg, center: gaze, mark: { ring: gaze } });
  const box = { x0: 0.4, y0: 0.35, x1: 0.62, y1: 0.66 };
  assert.ok((await brightness(ringed, jpeg, gaze, { x: box.x0, y: 0.5 })) < 170);
  assert.ok((await brightness(ringed, jpeg, gaze, { x: 0.5, y: box.y0 })) < 170);
  const { region } = await gazeView(jpeg, gaze);
  // The ring's radius is 18 px of the picture, which is never enlarged past its view.
  const width = (await sharp(ringed).metadata()).width ?? 1;
  const ringEdge = { x: gaze.x + (18 / width) * (region.x1 - region.x0), y: gaze.y };
  assert.ok((await brightness(ringed, jpeg, gaze, ringEdge)) > 200);
  assert.ok((await brightness(ringed, jpeg, gaze, gaze)) < 170);
  // A traced subject: its outline is drawn, and its inside stays the picture.
  const contour = [
    { x: 0.45, y: 0.6 },
    { x: 0.5, y: 0.4 },
    { x: 0.55, y: 0.6 },
  ];
  const traced = await picture({ jpeg, center: gaze, mark: { contour } });
  assert.ok((await brightness(traced, jpeg, gaze, { x: 0.5, y: 0.6 })) > 200);
  assert.ok((await brightness(traced, jpeg, gaze, { x: 0.5, y: 0.53 })) < 170);
  for (const each of [ringed, traced]) {
    assert.ok(complete(each));
    assert.equal((await sharp(each).metadata()).exif, undefined);
  }
});

/** The largest picture, with no budget to fit. */
async function picture(source: PictureSource) {
  const made = await momentPicture(source, () => true);
  assert.ok(made !== null);
  return made;
}

/** A whole JPEG: its start marker, and its end marker FFD9 last. */
const complete = (jpeg: Buffer) =>
  jpeg[0] === 0xff && jpeg[1] === 0xd8 && jpeg.at(-2) === 0xff && jpeg.at(-1) === 0xd9;

/** A large frame full of small shapes, so its picture is too big for a small body. */
async function busyFrame() {
  const shapes = Array.from({ length: 300 }, (_, i) => {
    const colors = ['#cc9966', '#66aa88', '#aa55cc', '#eeeeee', '#333355'];
    return `<circle cx="${(i * 97) % 1600}" cy="${(i * 61) % 1200}" r="${6 + ((i * 13) % 30)}" fill="${colors[i % 5]}"/>`;
  }).join('');
  return sharp(
    Buffer.from(
      `<svg width="1600" height="1200" xmlns="http://www.w3.org/2000/svg"><rect width="1600" height="1200" fill="#7a8a6a"/>${shapes}</svg>`,
    ),
  )
    .jpeg()
    .toBuffer();
}

test('a body over its budget steps the picture down until it fits, whole and still marked', async () => {
  const bot = await receiver(200, { success: true, runUuid: 'run-0002' });
  const journal = Journal.open(':memory:');
  const link: GrokBotLink = {
    url: bot.url,
    auth: 'bearer',
    key: 'crsr_synthetic',
    timeoutMs: 2000,
  };
  const gaze = { x: 0.5, y: 0.5 };
  const source = { jpeg: await busyFrame(), center: gaze, mark: { ring: gaze } };
  const sent = (index: number) => {
    const body = bot.received[index]?.body ?? '';
    const image = JSON.parse(body).image;
    return { body, image: image === undefined ? null : Buffer.from(image.base64, 'base64') };
  };
  const data = (taskId: string) =>
    journal
      .all()
      .find((event) => event.type === 'grokbot.delivery.started' && event.data.taskId === taskId)
      ?.data;
  try {
    // With room, the picture is the largest step: 480 wide.
    await new GrokBotMoments(journal, link, deliver, 1_000_000).send(
      await moment({ momentId: 'mom_roomy_1', taskId: 'tsk_roomy_1', picture: source }),
    );
    const roomy = sent(0);
    assert.ok(roomy.image !== null && complete(roomy.image));
    assert.equal((await sharp(roomy.image).metadata()).width, 480);
    assert.ok(Buffer.byteLength(roomy.body) > 4000);

    // Under 4,000 bytes, it steps down until the whole body fits, and stays whole and marked.
    await new GrokBotMoments(journal, link, deliver, 4000).send(
      await moment({ momentId: 'mom_tight_1', taskId: 'tsk_tight_1', picture: source }),
    );
    const tight = sent(1);
    assert.ok(Buffer.byteLength(tight.body) <= 4000, String(Buffer.byteLength(tight.body)));
    assert.ok(tight.image !== null && complete(tight.image));
    const width = (await sharp(tight.image).metadata()).width ?? 0;
    assert.ok(width >= 160 && width <= 320, String(width));
    const { region } = await gazeView(source.jpeg, gaze);
    const ringEdge = { x: gaze.x + (18 / width) * (region.x1 - region.x0), y: gaze.y };
    assert.ok((await brightness(tight.image, source.jpeg, gaze, ringEdge)) > 180);
    assert.deepEqual(data('tsk_tight_1'), {
      momentId: 'mom_tight_1',
      attempt: 0,
      taskId: 'tsk_tight_1',
      runUuid: 'run-0002',
      pictureBytes: tight.image.length,
      bodyBytes: Buffer.byteLength(tight.body),
    });

    // When no step fits, the moment goes without a picture rather than with a broken one.
    await new GrokBotMoments(journal, link, deliver, 1200).send(
      await moment({ momentId: 'mom_none_1', taskId: 'tsk_none_1', picture: source }),
    );
    const none = sent(2);
    assert.equal(none.image, null);
    assert.equal(JSON.parse(none.body).momentId, 'mom_none_1');
    assert.deepEqual(data('tsk_none_1'), {
      momentId: 'mom_none_1',
      attempt: 0,
      taskId: 'tsk_none_1',
      runUuid: 'run-0002',
      pictureBytes: null,
      bodyBytes: Buffer.byteLength(none.body),
    });
    assert.ok(!JSON.stringify(journal.all()).includes(tight.image.toString('base64').slice(0, 40)));
  } finally {
    await bot.close();
  }
});

test('a picture is never sent unless its JPEG is whole', async () => {
  const gaze = { x: 0.5, y: 0.5 };
  const source = { jpeg: await frame(), center: gaze, mark: { ring: gaze } };
  const seen: Buffer[] = [];
  // Every step the fit is asked about is whole, and a fit that takes none gives no picture.
  assert.equal(
    await momentPicture(source, (each) => {
      seen.push(each);
      return false;
    }),
    null,
  );
  assert.equal(seen.length, 15);
  assert.ok(seen.every(complete));
  // A JPEG cut short, as the Bot's 2.7 KB copy of a 12 KB one was, is not whole.
  const [first] = seen;
  assert.ok(first !== undefined && wholeJpeg(first));
  assert.equal(wholeJpeg(first.subarray(0, Math.floor(first.length / 2))), false);
  assert.equal(wholeJpeg(Buffer.alloc(0)), false);
});
