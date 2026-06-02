import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Loader } from "@mantine/core";
import { IconAlertTriangle } from "@tabler/icons-react";
import ReactMarkdown, { type Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ANCHOR_MARK_CLASS,
  rehypeAnchorMark,
  remarkStripComments,
  remarkSupplementMarkers,
} from "./plugins";
import { codePointAnchorToUtf16 } from "./offsets";
import type { CodePointAnchor } from "./types";

export interface MarkdownHighlightViewerProps {
  /** URL to fetch the paper's `markdown.md` as text. */
  markdownUrl: string;
  /**
   * Code-point range of the active quote to highlight + scroll to. Null/omitted
   * means "browse mode" — render the Markdown with no highlight.
   */
  anchor?: CodePointAnchor | null;
  /** The quote text, used for the locating / could-not-locate messages. */
  label?: string;
  /** True while the anchor is still being resolved (async round-trip in flight). */
  pending?: boolean;
}

// GFM tables on, single-tilde strikethrough off (so a lone tilde in data renders
// literally), the supplement-marker → heading transform, then a strip of the
// remaining structural comments (page/table/figure/end) so none leak as literal
// `<!--…-->` text. Order matters: the supplement transform runs before the strip.
const REMARK_PLUGINS: Options["remarkPlugins"] = [
  [remarkGfm, { singleTilde: false }],
  remarkSupplementMarkers,
  remarkStripComments,
];

/**
 * Renders a paper's `markdown.md` (the assembled source.md + converted xlsx/docx
 * supplements) and highlights the quote at `anchor`, scrolling it into view.
 *
 * The Markdown analogue of `PdfHighlightViewer`: the highlight is painted by a
 * rehype plugin that splits hast text nodes at the anchor boundaries, so a quote
 * spanning several table cells highlights each cell without breaking the table.
 */
export const MarkdownHighlightViewer = ({
  markdownUrl,
  anchor,
  label,
  pending,
}: MarkdownHighlightViewerProps) => {
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Fetch the Markdown text whenever the URL changes.
  useEffect(() => {
    let cancelled = false;
    setMarkdown(null);
    setError(null);
    fetch(markdownUrl)
      .then((r) => {
        if (!r.ok) throw new Error(`Failed to load Markdown (${r.status})`);
        return r.text();
      })
      .then((text) => {
        if (!cancelled) setMarkdown(text);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [markdownUrl]);

  // Convert the code-point anchor to UTF-16 once per (markdown, anchor). This is
  // the only conversion site — the rehype plugin accepts only Utf16Anchor.
  const u16Anchor = useMemo(
    () =>
      markdown && anchor ? codePointAnchorToUtf16(markdown, anchor) : null,
    [markdown, anchor],
  );

  const rehypePlugins = useMemo<Options["rehypePlugins"]>(
    () => [[rehypeAnchorMark, { anchor: u16Anchor }]],
    [u16Anchor],
  );

  // After the highlight renders, scroll it into view (centered).
  useEffect(() => {
    if (!u16Anchor || !markdown) return;
    const id = requestAnimationFrame(() => {
      containerRef.current
        ?.querySelector(`mark.${ANCHOR_MARK_CLASS}`)
        ?.scrollIntoView({ block: "center" });
    });
    return () => cancelAnimationFrame(id);
  }, [u16Anchor, markdown]);

  const locating = pending && label;
  const notLocated =
    !pending && label && (anchor === null || anchor === undefined);

  return (
    <div className="relative flex h-full w-full flex-col">
      {locating && (
        <Alert
          icon={<Loader size={16} />}
          color="blue"
          variant="light"
          className="rounded-none"
        >
          Locating quote in Markdown: &ldquo;{label}&rdquo;
        </Alert>
      )}
      {notLocated && (
        <Alert
          icon={<IconAlertTriangle size={16} />}
          color="yellow"
          variant="light"
          className="rounded-none"
        >
          Could not locate quote in Markdown: &ldquo;{label}&rdquo;
        </Alert>
      )}

      <div ref={containerRef} className="min-h-0 flex-1 overflow-auto p-4">
        {error ? (
          <Alert
            icon={<IconAlertTriangle size={16} />}
            color="red"
            variant="light"
          >
            {error}
          </Alert>
        ) : markdown === null ? (
          <div className="flex h-full items-center justify-center">
            <Loader size="md" />
          </div>
        ) : (
          <div className="flowa-source-markdown">
            <ReactMarkdown
              remarkPlugins={REMARK_PLUGINS}
              rehypePlugins={rehypePlugins}
            >
              {markdown}
            </ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  );
};
