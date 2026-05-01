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

- `sanitizeLlmMarkdown(md, mapping)` — single sanitization pipeline for
  LLM-generated Markdown: marked → DOMPurify → citation-link validation.
- `parseCitationsFromMarkdown(md)` — extract `(paperId, quote)` pairs from
  citation links of the form `[display](#cite:AuthorYear "verbatim quote")`.
- `parseCiteHref(href)` / `isCitationHref(href)` — parse / validate citation
  fragment URLs.
- `LlmContent` — renders LLM Markdown with click-to-resolve citation links.
- `PdfHighlightViewer` — react-pdf-based viewer with 0–1000 normalized bbox
  highlight overlays.

## Citation contract

Citation links use the form:

```text
[display text](#cite:AuthorYear "verbatim quote")
```

`AuthorYear` matches `[A-Za-z]+\d+` and must resolve in the supplied
`PaperIdMapping.byAuthorYear`. The title attribute carries the verbatim quote
used to resolve a bbox. `sanitizeLlmMarkdown` strips every `<a>` tag that
fails this format or whose `AuthorYear` is absent from the mapping.

## Bbox coordinate scale

All highlight bboxes use a 0–1000 normalized scale (left/top/right/bottom),
1-indexed pages. The viewer rescales to rendered pixels.

## Tailwind

The components ship with Tailwind utility classes (e.g. `flex`, `text-cyan-700`).
Consumers using Tailwind should add the package's `dist` directory to the
`content` array in `tailwind.config`:

```js
{
  content: [
    "./src/**/*.{ts,tsx}",
    "./node_modules/@flowajs/react-viewer/dist/**/*.{js,mjs}",
  ],
}
```

If you don't use Tailwind, the components still render — only the visual
treatment of citation links and viewer chrome is affected.

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
