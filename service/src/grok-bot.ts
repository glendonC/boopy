/**
 * The person's own Grok Bot, reached through its routine webhook. Each boop moment goes there as
 * one JSON body with a small picture of what they looked at, so they can pick it up later on
 * their other devices. Off unless the person names a webhook file. The key and the URL are never
 * logged or journaled: the journal keeps whether a run started, and the reply's run id.
 */
import { createHmac, randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import sharp from 'sharp';
import { z } from 'zod';
import type { Point } from './contracts.ts';
import { gazeView } from './evidence.ts';
import type { Journal } from './journal.ts';

export type GrokBotLink = {
  readonly url: string;
  /** crsr_ keys go as a Bearer token; whsec_ secrets sign each body (Standard Webhooks). */
  readonly auth: 'bearer' | 'signature';
  readonly key: string;
  readonly timeoutMs: number;
};

const WebhookFile = z.object({ url: z.string(), key: z.string() }).strict();

/** Reads {"url","key"} from a file only the person can read. Errors never quote the file. */
export async function loadGrokBot(file: string): Promise<GrokBotLink> {
  const info = await stat(file);
  if (!info.isFile() || (info.mode & 0o077) !== 0)
    throw new Error('The Grok Bot webhook file must be a file only you can read (chmod 600).');
  let parsed: z.infer<typeof WebhookFile>;
  try {
    parsed = WebhookFile.parse(JSON.parse(await readFile(file, 'utf8')));
  } catch {
    throw new Error(
      'The Grok Bot webhook file must hold {"url": ..., "key": ...} and nothing else.',
    );
  }
  let url: URL;
  try {
    url = new URL(parsed.url);
  } catch {
    throw new Error('The Grok Bot webhook URL is not a URL.');
  }
  if (url.protocol !== 'https:') throw new Error('The Grok Bot webhook URL must use https.');
  const auth = parsed.key.startsWith('crsr_')
    ? 'bearer'
    : parsed.key.startsWith('whsec_')
      ? 'signature'
      : null;
  if (auth === null) throw new Error('The Grok Bot key must start with crsr_ or whsec_.');
  return { url: url.href, auth, key: parsed.key, timeoutMs: 10_000 };
}

/** Standard Webhooks: "v1," and the HMAC-SHA256 of "{id}.{timestamp}.{body}" under the secret. */
export function webhookSignature(secret: string, id: string, timestamp: number, body: string) {
  const key = Buffer.from(secret.slice('whsec_'.length), 'base64');
  return `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64')}`;
}

export type Delivery =
  | { readonly outcome: 'started'; readonly runUuid: string | null }
  | { readonly outcome: 'failed'; readonly status: number | null };

/**
 * One POST, bounded, never retried. A 2xx reply means the Bot's run started, not that it
 * finished; a 200 that says success false did not start one. A redirect is a failure, so the key
 * never goes anywhere but the named URL.
 */
export async function deliver(
  link: GrokBotLink,
  body: string,
  now = Date.now(),
): Promise<Delivery> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (link.auth === 'bearer') headers.authorization = `Bearer ${link.key}`;
  else {
    const id = `msg_${randomUUID().replaceAll('-', '')}`;
    const timestamp = Math.floor(now / 1000);
    headers['webhook-id'] = id;
    headers['webhook-timestamp'] = String(timestamp);
    headers['webhook-signature'] = webhookSignature(link.key, id, timestamp, body);
  }
  try {
    const response = await fetch(link.url, {
      method: 'POST',
      headers,
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(link.timeoutMs),
    });
    const reply: unknown = await response.json().catch(() => null);
    const fields =
      reply !== null && typeof reply === 'object' ? (reply as Record<string, unknown>) : {};
    if (!response.ok || fields.success === false)
      return { outcome: 'failed', status: response.status };
    const runUuid =
      typeof fields.runUuid === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(fields.runUuid)
        ? fields.runUuid
        : null;
    return { outcome: 'started', runUuid };
  } catch {
    return { outcome: 'failed', status: null };
  }
}

/** How the picture marks what the person pointed at: the subject's traced outline, or a ring. */
export type PictureMark = { readonly contour: readonly Point[] } | { readonly ring: Point };

/** The ring's radius and every stroke, in pixels of the picture (at most 480 on a side). */
const RING_RADIUS = 18;
const STROKE = 4;

/**
 * The view around where the person looked, with what they pointed at marked as the headset marks
 * it: the subject's traced outline, else a small ring at the pointed spot, never the model's loose
 * box. No text. Re-encoded small enough to send (about 40 KB), with no capture metadata.
 */
export async function momentPicture(
  jpeg: Buffer,
  center: Point,
  mark: PictureMark,
): Promise<Buffer> {
  const view = await gazeView(jpeg, center);
  const small = await sharp(view.image)
    .resize({ width: 480, height: 480, fit: 'inside', withoutEnlargement: true })
    .toBuffer({ resolveWithObject: true });
  const { width, height } = small.info;
  const r = view.region;
  const at = (point: Point) => ({
    x: Math.round(((point.x - r.x0) / (r.x1 - r.x0)) * width),
    y: Math.round(((point.y - r.y0) / (r.y1 - r.y0)) * height),
  });
  const shape =
    'contour' in mark
      ? `<polygon points="${mark.contour
          .map(at)
          .map(({ x, y }) => `${x},${y}`)
          .join(
            ' ',
          )}" fill="none" stroke="#ffffff" stroke-width="${STROKE}" stroke-linejoin="round"/>`
      : `<circle cx="${at(mark.ring).x}" cy="${at(mark.ring).y}" r="${RING_RADIUS}" fill="none" stroke="#ffffff" stroke-width="${STROKE}"/>`;
  const marked = await sharp(small.data)
    .composite([
      {
        input: Buffer.from(
          `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">${shape}</svg>`,
        ),
        top: 0,
        left: 0,
      },
    ])
    .toBuffer();
  let picture = await sharp(marked).jpeg({ quality: 70 }).toBuffer();
  for (const quality of [55, 40]) {
    if (picture.length <= 40_000) break;
    picture = await sharp(marked).jpeg({ quality }).toBuffer();
  }
  return picture;
}

export type Moment = {
  /** One boop: its opening and each answer after it share this id. */
  readonly momentId: string;
  /** 0 for the opening, then the answer's attempt number. */
  readonly attempt: number;
  readonly taskId: string;
  readonly sessionId: string;
  readonly subject: string | null;
  readonly term: {
    readonly text: string;
    readonly language: string;
    readonly languageName: string;
  } | null;
  /** Null before an answer; an unclear answer is not heard. */
  readonly heard: boolean | null;
  readonly memory: string | null;
  readonly recorded: boolean;
  /** The boop was made by pointing alone, with no words heard. */
  readonly pointed: boolean;
  readonly picture: Buffer | null;
};

const article = (noun: string) => (/^[aeiou]/i.test(noun) ? `an ${noun}` : `a ${noun}`);

/** The one plain sentence the Bot reads first, in the person's voice. */
export function momentMessage(moment: Moment): string {
  const where = moment.recorded ? 'in my trip footage' : 'around me';
  const did = moment.pointed ? 'pointed at' : 'looked at';
  const seen =
    moment.subject === null
      ? `I ${did} something ${where}, and Boopy was not sure what it was.`
      : `I ${did} something ${where}, and Boopy thought it was ${article(moment.subject)}.`;
  if (moment.term === null) return `From my Boopy headset: ${seen}`;
  const word = `Boopy gave the ${moment.term.languageName} word ${moment.term.text} (Wikidata via Zetaris)`;
  const said =
    moment.heard === null
      ? '.'
      : moment.heard
        ? ' and heard me say it.'
        : ' and did not hear me say it.';
  return `From my Boopy headset: ${seen} ${word}${said}`;
}

/** Sends moments in the background and journals each delivery's outcome, once per attempt. */
export class GrokBotMoments {
  readonly #journal: Journal;
  readonly #link: GrokBotLink;
  readonly #deliver: typeof deliver;

  constructor(journal: Journal, link: GrokBotLink, send: typeof deliver = deliver) {
    this.#journal = journal;
    this.#link = link;
    this.#deliver = send;
  }

  async send(moment: Moment): Promise<Delivery | null> {
    const id = `gbd_${moment.momentId.slice(4)}_${moment.attempt}`;
    if (this.#journal.has(id)) return null;
    const body = JSON.stringify({
      source: 'Boopy',
      kind: 'moment',
      momentId: moment.momentId,
      message: momentMessage(moment),
      subject: moment.subject,
      term:
        moment.term === null
          ? null
          : {
              text: moment.term.text,
              language: moment.term.language,
              source: 'Wikidata via Zetaris',
            },
      heard: moment.heard,
      memory: moment.memory,
      recorded: moment.recorded,
      ...(moment.picture === null
        ? {}
        : { image: { mediaType: 'image/jpeg', base64: moment.picture.toString('base64') } }),
    });
    const delivery = await this.#deliver(this.#link, body);
    if (this.#journal.has(id)) return delivery;
    const base = { momentId: moment.momentId, attempt: moment.attempt, taskId: moment.taskId };
    this.#journal.append(
      delivery.outcome === 'started'
        ? {
            type: 'grokbot.delivery.started',
            session: moment.sessionId,
            actor: 'system',
            data: { ...base, runUuid: delivery.runUuid },
          }
        : {
            type: 'grokbot.delivery.failed',
            session: moment.sessionId,
            actor: 'system',
            data: { ...base, status: delivery.status },
          },
      id,
      new Date().toISOString(),
    );
    return delivery;
  }

  /** Whether a delivery for this task has started; only then may a line say it was sent. */
  started(taskId: string): boolean {
    return this.#journal
      .withTypePrefix('grokbot.delivery.started')
      .some((event) => event.type === 'grokbot.delivery.started' && event.data.taskId === taskId);
  }
}
