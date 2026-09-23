import { SCALE } from "./geometry";
import type { HighlightBbox } from "./types";

/**
 * A run of text as pdf.js reports it from `getTextContent()`: the string,
 * the matrix that places it (`[a, b, c, d, e, f]`, with the baseline running
 * along `(a, b)` from the origin `(e, f)`), its advance and height in PDF
 * user space, and the name of its font in the content's `styles`.
 */
export interface TextRun {
  str: string;
  transform: number[];
  width: number;
  height: number;
  hasEOL?: boolean;
  fontName?: string;
  /** Writing direction: `ltr`, `rtl`, or `ttb` for vertical text. */
  dir?: string;
}

/** The font metrics pdf.js reports per font in `getTextContent().styles`. */
export interface TextStyle {
  /** Fraction of the font size above the baseline that glyphs reach. */
  ascent?: number;
  /** Fraction of the font size below the baseline, negative. */
  descent?: number;
  vertical?: boolean;
  /**
   * The generic family pdf.js substitutes for the font when it lays text
   * out itself: `serif`, `sans-serif` or `monospace`.
   */
  fontFamily?: string;
}

/**
 * How wide `text` is when set in the generic `fontFamily`, in any unit:
 * only ratios within one run are used.
 */
export type MeasureText = (text: string, fontFamily: string) => number;

/**
 * A `MeasureText` backed by a 2D canvas, caching each measurement, or null
 * where there is no canvas to measure with (a server, a test DOM).
 */
export function canvasMeasurer(): MeasureText | null {
  if (typeof document === "undefined") return null;
  const context = document.createElement("canvas").getContext("2d");
  if (!context || typeof context.measureText !== "function") return null;
  const cache = new Map<string, number>();
  return (text, fontFamily) => {
    const key = `${fontFamily}\u0000${text}`;
    let width = cache.get(key);
    if (width === undefined) {
      context.font = `100px ${fontFamily}`;
      width = context.measureText(text).width;
      cache.set(key, width);
    }
    return width;
  };
}

/** The part of a pdf.js page viewport the index needs. */
export interface ViewportLike {
  width: number;
  height: number;
  convertToViewportPoint(x: number, y: number): number[];
}

/**
 * The part of a pdf.js document the index needs. Structural, so a test can
 * hand in a plain object and the viewer can hand in the real proxy.
 */
export interface PdfDocumentLike {
  numPages: number;
  getPage(pageNumber: number): Promise<{
    getTextContent(): Promise<{
      items: unknown[];
      styles?: Record<string, TextStyle>;
    }>;
    getViewport(params: { scale: number }): ViewportLike;
  }>;
}

interface IndexedRun {
  /** The run's span in the page's `text`. */
  start: number;
  end: number;
  /** Baseline origin and unit vectors along the baseline and up from it, in user space. */
  origin: [number, number];
  along: [number, number];
  up: [number, number];
  width: number;
  height: number;
  ascent: number;
  descent: number;
  vertical: boolean;
  rtl: boolean;
  /**
   * Where each character boundary of the run falls, as a fraction of its
   * advance (`offsets[i]` for the boundary before character `i`, ending at
   * 1), or null to place characters evenly.
   */
  offsets: number[] | null;
}

export interface PageTextIndex {
  page: number;
  /**
   * The page's text with runs joined end to end, plus a newline where pdf.js
   * marks a line end so a query can match across it.
   */
  text: string;
  runs: IndexedRun[];
  viewport: ViewportLike;
}

export interface SearchHit {
  page: number;
  /** Offsets into the page's `text`. */
  start: number;
  end: number;
  /** One box per text run the match touches, in the page's 0–SCALE frame. */
  bboxes: HighlightBbox[];
}

export interface SearchResult {
  hits: SearchHit[];
  /** True when the search stopped at `MAX_HITS` with matches left unread. */
  capped: boolean;
}

/** Matches beyond this many are not collected; browsers stop about here too. */
export const MAX_HITS = 1000;

/** pdf.js's own text-layer fallbacks for a font without metrics. */
const DEFAULT_ASCENT = 0.8;
const DEFAULT_DESCENT = -0.2;

/**
 * A font metric as reported, or the fallback when it is missing, NaN (a
 * Type3 font), zero (a descriptor with no extents) or of the wrong sign (a
 * descriptor with its descent written positive), clamped to the range real
 * fonts occupy so a bounding-box extreme cannot fuse adjacent lines.
 */
function metric(
  value: number | undefined,
  fallback: number,
  low: number,
  high: number,
): number {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value !== 0 &&
    Math.sign(value) === Math.sign(fallback)
    ? Math.min(high, Math.max(low, value))
    : fallback;
}

/**
 * Typographic characters mapped to what a keyboard produces: curly quotes to
 * straight ones, the hyphen and dash variants and the minus sign to a
 * hyphen, a no-break space to a space. Every replacement is one code unit for one, so
 * offsets into the text stay valid. Applied to the page text at index time
 * and to the query.
 */
export function normaliseChars(s: string): string {
  return s
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐‑‒–—―−]/g, "-")
    .replace(/ /g, " ");
}

function isTextRun(item: unknown): item is TextRun {
  return (
    typeof item === "object" &&
    item !== null &&
    typeof (item as TextRun).str === "string" &&
    Array.isArray((item as TextRun).transform)
  );
}

/**
 * The character boundaries of `str` as fractions of its width in
 * `fontFamily`, measured character by character (kerning is ignored), or
 * null if there is nothing to measure with or the measurements are unusable.
 * Both halves of a surrogate pair share the pair's end, since no match
 * starts inside one.
 */
function charOffsets(
  str: string,
  fontFamily: string | undefined,
  measure: MeasureText | null,
): number[] | null {
  if (!measure || !fontFamily) return null;
  const ends: number[] = [0];
  let total = 0;
  for (const ch of str) {
    const width = measure(ch, fontFamily);
    if (!Number.isFinite(width) || width < 0) return null;
    total += width;
    for (let unit = 0; unit < ch.length; unit++) ends.push(total);
  }
  if (!(total > 0)) return null;
  return ends.map((end) => end / total);
}

/**
 * Index one page's text runs against the viewport they will be drawn in.
 * With `measure`, characters are placed by their widths in the family pdf.js
 * substitutes for each run's font; without it, evenly along the run.
 */
export function buildPageIndex(
  page: number,
  items: unknown[],
  viewport: ViewportLike,
  styles: Record<string, TextStyle> = {},
  measure: MeasureText | null = null,
): PageTextIndex {
  let text = "";
  const runs: IndexedRun[] = [];
  for (const item of items) {
    if (!isTextRun(item)) continue;
    if (item.str.length > 0) {
      const a = item.transform[0] ?? 1;
      const b = item.transform[1] ?? 0;
      const c = item.transform[2] ?? 0;
      const d = item.transform[3] ?? 1;
      const alongLen = Math.hypot(a, b) || 1;
      const upLen = Math.hypot(c, d) || 1;
      const style = item.fontName ? styles[item.fontName] : undefined;
      const start = text.length;
      text += normaliseChars(item.str);
      runs.push({
        start,
        end: text.length,
        origin: [item.transform[4] ?? 0, item.transform[5] ?? 0],
        along: [a / alongLen, b / alongLen],
        up: [c / upLen, d / upLen],
        width: item.width,
        height: item.height,
        ascent: metric(style?.ascent, DEFAULT_ASCENT, 0.5, 1.2),
        descent: metric(style?.descent, DEFAULT_DESCENT, -0.5, -0.05),
        vertical: style?.vertical ?? false,
        rtl: item.dir === "rtl",
        // Measured on pdf.js's own characters: normaliseChars folds one
        // UTF-16 unit to one, so the offsets line up with the indexed text.
        offsets: charOffsets(item.str, style?.fontFamily, measure),
      });
    }
    // pdf.js starts a new run at every font change and emits a whitespace
    // run of its own where the layout has a gap, so runs join with nothing:
    // a separator here would split a word set in two fonts. Only a marked
    // line end becomes a newline.
    if (item.hasEOL) text += "\n";
  }
  return { page, text, runs, viewport };
}

/**
 * The box of the characters `[from, to)` of a run, in the page's 0–SCALE
 * frame. pdf.js gives no per-glyph positions, only the run's advance, so the
 * span is placed at the run's measured character boundaries scaled to that
 * advance: the approach pdf.js's own text layer takes, close wherever the
 * substitute family's proportions follow the embedded font's. Without
 * measurements the characters are spread evenly, which is exact only for
 * monospaced text. Vertically the box runs from the font's descent to its
 * ascent. A vertical run gets its whole box: pdf.js puts its origin at the
 * first glyph, centred on the column, and advances downward, recording the
 * advance in `height` and the em size in `width`. A right-to-left run has its
 * text in logical order while its advance runs left to right, so the span is
 * mirrored within the run.
 */
function runBbox(
  run: IndexedRun,
  from: number,
  to: number,
  page: number,
  viewport: ViewportLike,
): HighlightBbox {
  const length = run.end - run.start;
  const boundary = (i: number): number =>
    run.width *
    (run.offsets ? run.offsets[i - run.start]! : (i - run.start) / length);
  let s = run.vertical ? -run.width / 2 : boundary(from);
  let e = run.vertical ? run.width / 2 : boundary(to);
  if (run.rtl && !run.vertical) [s, e] = [run.width - e, run.width - s];
  const low = run.vertical ? -run.height : run.descent * run.height;
  const high = run.vertical ? 0 : run.ascent * run.height;
  const corner = (dist: number, rise: number): number[] =>
    viewport.convertToViewportPoint(
      run.origin[0] + run.along[0] * dist + run.up[0] * rise,
      run.origin[1] + run.along[1] * dist + run.up[1] * rise,
    );
  const corners = [
    corner(s, low),
    corner(e, low),
    corner(s, high),
    corner(e, high),
  ];
  const xs = corners.map((p) => p[0] ?? 0);
  const ys = corners.map((p) => p[1] ?? 0);
  return {
    page,
    left: (Math.min(...xs) / viewport.width) * SCALE,
    right: (Math.max(...xs) / viewport.width) * SCALE,
    top: (Math.min(...ys) / viewport.height) * SCALE,
    bottom: (Math.max(...ys) / viewport.height) * SCALE,
  };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The matcher for a query: case-insensitive; any whitespace in the query
 * matches any run of whitespace in the text, line breaks included; and a
 * word may be broken across lines with a hyphen ("hetero-\nzygous"), which
 * the pattern tolerates between any two of its characters rather than by
 * deleting characters from the text, so offsets stay valid. Null for a blank
 * query.
 */
export function queryPattern(query: string): RegExp | null {
  const parts = normaliseChars(query)
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => Array.from(part).map(escapeRegExp).join("(?:-\\n)?"));
  if (parts.length === 0) return null;
  return new RegExp(parts.join("\\s+"), "gi");
}

/** Index of the first run that ends after `offset`; runs are sorted and do not overlap. */
function firstRunEndingAfter(runs: IndexedRun[], offset: number): number {
  let lo = 0;
  let hi = runs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (runs[mid]!.end > offset) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/**
 * Every match of `query` across the indexed pages, in reading order, up to
 * `limit` of them.
 */
export function searchIndex(
  pages: PageTextIndex[],
  query: string,
  limit: number = MAX_HITS,
): SearchResult {
  const pattern = queryPattern(query);
  if (!pattern) return { hits: [], capped: false };
  const hits: SearchHit[] = [];
  for (const p of pages) {
    pattern.lastIndex = 0;
    for (let m = pattern.exec(p.text); m !== null; m = pattern.exec(p.text)) {
      if (hits.length >= limit) return { hits, capped: true };
      const start = m.index;
      const end = start + m[0].length;
      const bboxes: HighlightBbox[] = [];
      for (
        let k = firstRunEndingAfter(p.runs, start);
        k < p.runs.length && p.runs[k]!.start < end;
        k++
      ) {
        const r = p.runs[k]!;
        bboxes.push(
          runBbox(
            r,
            Math.max(r.start, start),
            Math.min(r.end, end),
            p.page,
            p.viewport,
          ),
        );
      }
      hits.push({ page: p.page, start, end, bboxes });
    }
  }
  return { hits, capped: false };
}

/** The viewport of a page whose text could not be read; it has no runs. */
const UNREADABLE_VIEWPORT: ViewportLike = {
  width: 1,
  height: 1,
  convertToViewportPoint: (x, y) => [x, y],
};

/**
 * Index every page of a document, in order. A page whose text cannot be
 * read is indexed as empty, as pdf.js's own find does, so one corrupt font
 * does not switch find off for the whole document. Returns null if
 * `isCancelled` reports true between pages, so a document that was closed
 * mid-way leaves no half-built index behind.
 */
export async function buildDocumentIndex(
  doc: PdfDocumentLike,
  isCancelled: () => boolean = () => false,
  measure: MeasureText | null = canvasMeasurer(),
): Promise<PageTextIndex[] | null> {
  const pages: PageTextIndex[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    if (isCancelled()) return null;
    try {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      pages.push(
        buildPageIndex(
          n,
          content.items,
          page.getViewport({ scale: 1 }),
          content.styles ?? {},
          measure,
        ),
      );
    } catch {
      pages.push({
        page: n,
        text: "",
        runs: [],
        viewport: UNREADABLE_VIEWPORT,
      });
    }
  }
  return isCancelled() ? null : pages;
}
