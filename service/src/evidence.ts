import sharp from 'sharp';
import type { Box, Point } from './contracts.ts';

/** What a model is shown besides the words: the frame with cue markers, and a close-up. */
export interface Evidence {
  readonly marked: Buffer;
  readonly crop: { readonly image: Buffer; readonly region: Box } | null;
}

/** One marker style everywhere, because marker colour and size change what models attend to. */
function marker(point: Point, label: 'P' | 'G' | 'T', width: number, height: number): string {
  const radius = Math.round(Math.min(width, height) * 0.03);
  const x = Math.round(point.x * width);
  const y = Math.round(point.y * height);
  const size = Math.round(radius * 1.2);
  const textX = Math.min(width - size, x + radius + 4);
  const textY = Math.max(size, y - radius);
  return [
    `<circle cx="${x}" cy="${y}" r="${radius}" fill="none" stroke="#ffffff" stroke-width="9"/>`,
    `<circle cx="${x}" cy="${y}" r="${radius}" fill="none" stroke="#ff2020" stroke-width="5"/>`,
    `<text x="${textX}" y="${textY}" font-family="Helvetica, Arial, sans-serif" font-size="${size}" font-weight="bold" fill="#ff2020" stroke="#ffffff" stroke-width="3" paint-order="stroke">${label}</text>`,
  ].join('');
}

/**
 * Draws the cues onto a copy of the frame and cuts a close-up around the main cue (the pointing
 * hand, else the head) from the unmarked original at native resolution. Nothing is downscaled:
 * small text needs every pixel the camera gave.
 */
export async function prepareEvidence(
  jpeg: Buffer,
  cues: { readonly gaze: Point | null; readonly pointer: Point | null },
  target: Point | null = null,
): Promise<Evidence> {
  const { width, height } = await sharp(jpeg).metadata();
  if (width === undefined || height === undefined) throw new Error('The frame has no size.');
  const markers = [
    ...(target === null ? [] : [marker(target, 'T', width, height)]),
    ...(cues.gaze === null ? [] : [marker(cues.gaze, 'G', width, height)]),
    ...(cues.pointer === null ? [] : [marker(cues.pointer, 'P', width, height)]),
  ];
  const marked =
    markers.length === 0
      ? jpeg
      : await sharp(jpeg)
          .composite([
            {
              input: Buffer.from(
                `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">${markers.join('')}</svg>`,
              ),
              top: 0,
              left: 0,
            },
          ])
          .jpeg({ quality: 88 })
          .toBuffer();
  const focus = target ?? cues.pointer ?? cues.gaze;
  if (focus === null) return { marked, crop: null };
  const side = Math.round(Math.min(width, height) * 0.5);
  const left = Math.min(width - side, Math.max(0, Math.round(focus.x * width - side / 2)));
  const top = Math.min(height - side, Math.max(0, Math.round(focus.y * height - side / 2)));
  const image = await sharp(jpeg)
    .extract({ left, top, width: side, height: side })
    .jpeg({ quality: 92 })
    .toBuffer();
  return {
    marked,
    crop: {
      image,
      region: {
        x0: left / width,
        y0: top / height,
        x1: (left + side) / width,
        y1: (top + side) / height,
      },
    },
  };
}

/**
 * What the person looks at, even when it is small: a view of the frame around the gaze, 40 percent
 * of each side, centred on the gaze and kept inside the frame, cut from the unmarked original at
 * native resolution. Its region is in frame coordinates.
 */
export async function gazeView(
  jpeg: Buffer,
  gaze: Point,
): Promise<{ readonly image: Buffer; readonly region: Box }> {
  const { width, height } = await sharp(jpeg).metadata();
  if (width === undefined || height === undefined) throw new Error('The frame has no size.');
  const w = Math.round(width * 0.4);
  const h = Math.round(height * 0.4);
  const left = Math.min(width - w, Math.max(0, Math.round(gaze.x * width - w / 2)));
  const top = Math.min(height - h, Math.max(0, Math.round(gaze.y * height - h / 2)));
  const image = await sharp(jpeg)
    .extract({ left, top, width: w, height: h })
    .jpeg({ quality: 92 })
    .toBuffer();
  return {
    image,
    region: { x0: left / width, y0: top / height, x1: (left + w) / width, y1: (top + h) / height },
  };
}

/** A box given in a view's own 0 to 1 coordinates, in the frame's. */
export function fromView(box: Box, region: Box): Box {
  const w = region.x1 - region.x0;
  const h = region.y1 - region.y0;
  return {
    x0: region.x0 + box.x0 * w,
    y0: region.y0 + box.y0 * h,
    x1: region.x0 + box.x1 * w,
    y1: region.y0 + box.y1 * h,
  };
}

export function pointFromView(point: Point, region: Box): Point {
  return {
    x: region.x0 + point.x * (region.x1 - region.x0),
    y: region.y0 + point.y * (region.y1 - region.y0),
  };
}

/** A frame box in a view's coordinates, cut to the view; null when it lies outside it. */
export function intoView(box: Box, region: Box): Box | null {
  const w = region.x1 - region.x0;
  const h = region.y1 - region.y0;
  const clip = (value: number) => Math.min(1, Math.max(0, value));
  const inside = {
    x0: clip((box.x0 - region.x0) / w),
    y0: clip((box.y0 - region.y0) / h),
    x1: clip((box.x1 - region.x0) / w),
    y1: clip((box.y1 - region.y0) / h),
  };
  return inside.x1 > inside.x0 && inside.y1 > inside.y0 ? inside : null;
}
