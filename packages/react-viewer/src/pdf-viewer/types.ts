/** A single bounding box in the 0–1000 normalized coordinate scale. */
export interface HighlightBbox {
  page: number;
  top: number;
  left: number;
  bottom: number;
  right: number;
}

/** A highlight to render, consisting of one or more bounding boxes. */
export interface PdfHighlight {
  /** Bounding boxes (0–1000 normalized scale). Must be sorted by page/position. */
  bboxes: HighlightBbox[];
  /** Optional label shown when the quote could not be located in the PDF. */
  label?: string;
}
