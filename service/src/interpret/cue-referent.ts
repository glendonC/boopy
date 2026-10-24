import type { Box, Cues, DepthGrid, Item, Point } from '../contracts.ts';

/** A cue counts as held up close when the depth at its point is at most this many meters. */
export const NEAR_METERS = 0.8;

/** Which of the person's cues chose a subject, and how far away depth put it. */
export interface ReferentCue {
  readonly cue: 'gaze' | 'pointer';
  readonly meters: number;
}

/** The depth sample of the grid cell that holds an image point; null where depth had no answer. */
function depthAt(grid: DepthGrid, point: Point): number | null {
  const column = Math.min(grid.columns - 1, Math.max(0, Math.floor(point.x * grid.columns)));
  const row = Math.min(grid.rows - 1, Math.max(0, Math.floor(point.y * grid.rows)));
  return grid.meters[row * grid.columns + column] ?? null;
}

/**
 * The median depth of the cells whose centers lie inside a box, or of the cell under its center
 * when no center does; cells without depth are left out, and null when none has depth.
 */
function boxDepth(grid: DepthGrid, box: Box): number | null {
  const inside: (number | null)[] = [];
  for (let row = 0; row < grid.rows; row += 1)
    for (let column = 0; column < grid.columns; column += 1) {
      const x = (column + 0.5) / grid.columns;
      const y = (row + 0.5) / grid.rows;
      if (x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1)
        inside.push(grid.meters[row * grid.columns + column] ?? null);
    }
  if (inside.length === 0)
    inside.push(depthAt(grid, { x: (box.x0 + box.x1) / 2, y: (box.y0 + box.y1) / 2 }));
  const known = inside.filter((meters) => meters !== null).sort((a, b) => a - b);
  if (known.length === 0) return null;
  const middle = Math.floor(known.length / 2);
  return known.length % 2 === 1
    ? (known[middle] as number)
    : ((known[middle - 1] as number) + (known[middle] as number)) / 2;
}

/**
 * The subject the person's own cue shows on a turn whose model named none. A cue counts when it
 * met a surface and depth puts that surface at most 0.8 m away, so the person holds it up close.
 * Exactly one of this interpretation's object or text boxes on this view must hold every cue that
 * counts, and that box's own median depth must be at most 0.8 m too; otherwise the subject stays
 * unknown. Nothing is added or changed: the item stays the model's proposal with the model's
 * confidence.
 */
export function cueReferent(
  items: readonly Item[],
  observation: { readonly id: string; readonly cues: Cues; readonly depth: DepthGrid | null },
): { readonly itemId: string; readonly referentCue: ReferentCue } | null {
  const grid = observation.depth;
  if (grid === null) return null;
  const boxes = items.filter(
    (item) =>
      (item.kind === 'object' || item.kind === 'text') &&
      item.grounding.kind === 'box' &&
      item.grounding.observationId === observation.id &&
      item.grounding.box !== undefined,
  );
  const near = (['pointer', 'gaze'] as const).flatMap((cue) => {
    const seen = observation.cues[cue];
    if (seen === undefined || !seen.onSurface) return [];
    const meters = depthAt(grid, seen.point);
    if (meters === null || meters > NEAR_METERS) return [];
    const { x, y } = seen.point;
    const holding = boxes.filter(({ grounding: { box } }) =>
      box === undefined ? false : x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1,
    );
    return [{ cue, meters, holding }];
  });
  const first = near[0];
  if (first === undefined || first.holding.length !== 1) return null;
  const chosen = first.holding[0] as Item;
  if (near.some(({ holding }) => holding.length !== 1 || holding[0]?.id !== chosen.id)) return null;
  // A far box that only encloses something near, such as a table behind a held cup the model did
  // not propose, is not what the person holds up.
  const held = chosen.grounding.box === undefined ? null : boxDepth(grid, chosen.grounding.box);
  if (held === null || held > NEAR_METERS) return null;
  return { itemId: chosen.id, referentCue: { cue: first.cue, meters: first.meters } };
}
