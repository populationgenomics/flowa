# @flowajs/react-viewer

React components for rendering [flowa](https://github.com/populationgenomics/flowa)
pipeline outputs.

## Install

```bash
pnpm add @flowajs/react-viewer
# Plus the peer dependencies, if not already installed:
pnpm add react react-dom @mantine/core @mantine/hooks @tabler/icons-react
```

## Exports

- `LlmContent` — renders LLM-generated Markdown via
  [react-markdown](https://github.com/remarkjs/react-markdown) (GFM tables, raw
  HTML escaped) with click-to-resolve citation links. Links that aren't a valid
  `#cite:AuthorYear` resolving in the supplied mapping render as plain text.
- `PdfHighlightViewer` — react-pdf-based viewer with 0–1000 normalized bbox
  highlight overlays.
- `MarkdownHighlightViewer` — the Markdown analogue: renders a paper's assembled
  Markdown and highlights a citation's code-point anchor span (one `<mark>` per
  overlapping text node, so a table-row-spanning quote leaves the table intact).
- `parseCitationsFromMarkdown(md)` — extract `(paperId, quote)` pairs from
  citation links of the form `[display](#cite:AuthorYear "verbatim quote")`.
- `parseCiteHref(href)` / `isCitationHref(href)` — parse / validate citation
  fragment URLs.
- `matchFilesToPapers(filenames, papers)` — match uploaded files to papers by
  filename: a main paper PDF is `<id>.pdf`, a supplement is `<id>[_ ]supp…`
  (any extension), where `<id>` is a PubMed id or an encoded DOI. Returns
  `{ mains, supplements, unmatched }`, supplements sorted lexicographically.
  `parseSupplementFilename(name)` exposes the supplement-naming rule on its own.

## Citation contract

Citation links use the form:

```text
[display text](#cite:AuthorYear "verbatim quote")
```

`AuthorYear` matches `[A-Za-z]+\d+` and must resolve in the supplied
`PaperIdMapping.byAuthorYear`. The title attribute carries the verbatim quote
used to resolve a bbox. `LlmContent` renders any link that fails this format or
whose `AuthorYear` is absent from the mapping as plain text — raw HTML is
escaped (no `rehype-raw`), so untrusted model output can't inject markup.

## Bbox coordinate scale

All highlight bboxes use a 0–1000 normalized scale (left/top/right/bottom),
1-indexed pages. The viewer rescales to rendered pixels.

## Styles

The package ships a pre-built stylesheet at `@flowajs/react-viewer/styles.css`.
Import it once (e.g. in your top-level page or `_app.tsx`):

```tsx
import "@flowajs/react-viewer/styles.css";
```

The bundle contains only the Tailwind utilities used by the package itself —
no Preflight reset, so it won't fight your existing base styles (Mantine's
own reset stays in effect).

Consumers do **not** need a Tailwind toolchain. The CSS is statically built
at package release time; nothing in your `tailwind.config` needs to point at
`node_modules/@flowajs/react-viewer`.

## SSR

`PdfHighlightViewer` lazy-imports `react-pdf` on mount, so it is safe to
render on a server (it returns a `<Loader>` placeholder until `react-pdf`
loads in the browser). No `dynamic(() => …, { ssr: false })` wrapper needed.

`LlmContent` is server-render-safe.

## Worker assets

`PdfHighlightViewer` requires the consumer to serve `pdf.worker.min.mjs` and
`cmaps/` somewhere reachable, then pass URLs via `workerSrc` and `cMapUrl`
props:

```tsx
<PdfHighlightViewer
  pdfUrl={url}
  highlights={highlights}
  workerSrc="/pdfjs/pdf.worker.min.mjs"
  cMapUrl="/pdfjs/cmaps/"
/>
```

Both files ship with `react-pdf` under `node_modules/react-pdf/dist/`. Copy
them into your public assets at install time (e.g. via a postinstall script).

## Provenance

Every published version carries a sigstore provenance attestation. To verify:

```bash
npm audit signatures
# Or, for one package:
npm view @flowajs/react-viewer
```

## License

MIT.
