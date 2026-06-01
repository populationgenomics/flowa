import type { CodePointAnchor, Utf16Anchor } from "./types";

/**
 * Convert a code-point `[start, end)` anchor into UTF-16 offsets into `md`.
 *
 * This is the **sole minter** of {@link Utf16Anchor}: the single sanctioned
 * `as Utf16Anchor` cast in the codebase lives here, so nothing reaches the
 * rehype mark plugin without going through this conversion.
 *
 * flowa's wire format counts offsets in Unicode code points (Python `str`
 * indices); JS strings and the unist/rehype `position.offset` the plugin aligns
 * against count in UTF-16 code units. The two diverge by one per astral (non-BMP)
 * character preceding an offset (e.g. mathematical alphanumeric symbols 𝑝/𝛽). We
 * walk `md` by code point — the `for…of` iterator yields a 2-unit string per
 * surrogate pair — accumulating the UTF-16 length to read off at the start/end
 * boundaries. An offset that runs past the string end clamps to its UTF-16
 * length, so an out-of-range anchor degrades to a short/empty highlight rather
 * than throwing.
 */
export function codePointAnchorToUtf16(
  md: string,
  { start, end }: CodePointAnchor,
): Utf16Anchor {
  let codePoints = 0;
  let utf16 = 0;
  let utf16Start: number | null = start <= 0 ? 0 : null;
  let utf16End: number | null = end <= 0 ? 0 : null;
  for (const ch of md) {
    if (utf16Start !== null && utf16End !== null) break;
    utf16 += ch.length; // 1 for a BMP char, 2 for a surrogate pair
    codePoints += 1;
    if (utf16Start === null && codePoints === start) utf16Start = utf16;
    if (utf16End === null && codePoints === end) utf16End = utf16;
  }
  return { start: utf16Start ?? utf16, end: utf16End ?? utf16 } as Utf16Anchor;
}
