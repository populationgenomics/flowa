import type { HighlightBbox } from "./types";

/** Reference scale used by the pipeline (0–1000 normalized coordinates). */
export const SCALE = 1000;

/** A page rotation the viewer applies on top of the document's own. */
export type Rotation = 0 | 90 | 180 | 270;

/** The rotation one quarter turn clockwise (`1`) or anticlockwise (`-1`) away. */
export function turn(rotation: Rotation, quarterTurns: 1 | -1): Rotation {
  return ((((rotation + quarterTurns * 90) % 360) + 360) % 360) as Rotation;
}

/**
 * Map a bbox given in the frame pdf.js renders the page in by default (the
 * page's own /Rotate already applied, which is also the frame the pipeline's
 * bboxes are in) into the frame after a further clockwise turn by
 * `rotation`. Both frames are 0–SCALE on each axis, so the result is still a
 * fraction of the rendered page whatever its aspect ratio after the turn. A
 * clockwise quarter turn sends a point (x, y) to (SCALE − y, x): the left
 * edge becomes the top edge.
 */
export function rotateBbox(
  bbox: HighlightBbox,
  rotation: Rotation,
): HighlightBbox {
  switch (rotation) {
    case 0:
      return bbox;
    case 90:
      return {
        page: bbox.page,
        left: SCALE - bbox.bottom,
        right: SCALE - bbox.top,
        top: bbox.left,
        bottom: bbox.right,
      };
    case 180:
      return {
        page: bbox.page,
        left: SCALE - bbox.right,
        right: SCALE - bbox.left,
        top: SCALE - bbox.bottom,
        bottom: SCALE - bbox.top,
      };
    case 270:
      return {
        page: bbox.page,
        left: bbox.top,
        right: bbox.bottom,
        top: SCALE - bbox.right,
        bottom: SCALE - bbox.left,
      };
  }
}
