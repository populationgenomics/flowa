/**
 * A half-open `[start, end)` range into a paper's `markdown.md`, measured in
 * Unicode **code points** — Python `str` indices, exactly what
 * `anchorite.locate_quote_span` returns (mirrors `flowa.resolve.MarkdownAnchor`;
 * wire key `markdown_anchor`).
 *
 * The unit matters: JS strings index by UTF-16 code units, and so does the
 * unist/rehype `position.offset` the highlight viewer aligns against — a
 * non-BMP character (e.g. a mathematical alphanumeric symbol like 𝑝/𝛽) counts
 * as 2 there but as 1 here. So these offsets must be converted before use:
 * `codePointAnchorToUtf16` turns a `CodePointAnchor` into a {@link Utf16Anchor},
 * the only form the rehype mark plugin accepts. This stays a plain interface
 * (it's wire data deserialized from JSON in several places); the conversion
 * boundary is enforced on the UTF-16 side instead — see below.
 */
export interface CodePointAnchor {
  start: number;
  end: number;
}

/**
 * Compile-time-only brand. `unique symbol` is never assigned at runtime, so the
 * property exists purely in the type world and branding costs nothing. It makes
 * {@link Utf16Anchor} structurally distinct from {@link CodePointAnchor}, which
 * TypeScript's structural typing would otherwise treat as the same `{start,end}`
 * shape and freely interchange.
 */
declare const utf16Brand: unique symbol;

/**
 * A half-open `[start, end)` range whose offsets are **UTF-16 code-unit**
 * indices into the markdown string — the unit JS `String` methods and the
 * unist/rehype `position.offset` use. The rehype mark plugin accepts only this
 * type, and `codePointAnchorToUtf16` is the *sole minter* of it (the one place
 * allowed to assert the brand). Net effect: you cannot reach the plugin with
 * un-converted offsets — a raw `CodePointAnchor` or a hand-built `{start,end}`
 * both fail to compile.
 *
 * The brand is **asymmetric** by design: `CodePointAnchor` is left unbranded, so
 * a `Utf16Anchor` is still assignable *to* a plain `{start,end}` (you can read
 * `.start`/`.end`), and — the one thing this does not catch — could be passed
 * back into the converter. That reverse path is a non-risk here (the converter
 * is called once, on freshly-deserialized wire data), and branding only the
 * UTF-16 side keeps the wire type cast-free at its many JSON deserialize sites.
 */
export type Utf16Anchor = {
  start: number;
  end: number;
  readonly [utf16Brand]: true;
};
