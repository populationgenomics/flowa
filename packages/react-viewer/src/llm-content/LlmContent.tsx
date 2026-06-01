import { useMemo, type FC } from "react";
import ReactMarkdown, { type Components, type Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import { parseCiteHref } from "../citations/sanitize";
import type { PaperIdMapping } from "../citations/types";

export interface LlmContentProps {
  /** Raw Markdown from LLM output. */
  markdown: string | null | undefined;
  /** AuthorYear ↔ DOI mapping for validating citation links. */
  paperIdMapping: PaperIdMapping;
  /**
   * Called when the user clicks a citation link. When provided, validated
   * citation links render as clickable spans. When omitted, citation links
   * are stripped to plain text (same as invalid links).
   *
   * `paperId` is the AuthorYear label; `quote` is the verbatim text from the
   * link title attribute (used for highlight resolution).
   */
  onCitationClick?: (parsed: { paperId: string; quote: string }) => void;
}

// Keep GFM tables on, but disable single-tilde strikethrough so a lone tilde
// in scientific text (e.g. "~22 years") renders literally instead of striking.
const REMARK_PLUGINS: Options["remarkPlugins"] = [
  [remarkGfm, { singleTilde: false }],
];

/**
 * Renders LLM-generated Markdown with citation-link handling.
 *
 * react-markdown (remark → rehype → React) is the whole pipeline: it escapes
 * raw HTML and URL-sanitizes hrefs by default (no `rehype-raw`), so untrusted
 * LLM output can't inject markup. The only customization is the `a` renderer,
 * which turns validated `#cite:AuthorYear` links into clickable spans and
 * strips every other link (external URLs, hallucinated/invalid citations) to
 * plain text.
 */
export const LlmContent: FC<LlmContentProps> = ({
  markdown,
  paperIdMapping,
  onCitationClick,
}) => {
  const components = useMemo<Components>(
    () => ({
      a({ href, title, children }) {
        const parsed = href ? parseCiteHref(href) : null;
        const known = parsed
          ? paperIdMapping.byAuthorYear[parsed.paperId]
          : undefined;
        if (parsed && known && onCitationClick) {
          const quote = title ?? "";
          // Render as a <span> so it flows inline with surrounding text (a
          // <button> creates an atomic inline box that prevents adjacent
          // punctuation from staying on the same line).
          return (
            <span
              role="button"
              tabIndex={0}
              data-testid="citation-link"
              className="cursor-pointer text-cyan-700 hover:text-cyan-900 hover:underline"
              onClick={(e) => {
                e.stopPropagation();
                onCitationClick({ paperId: parsed.paperId, quote });
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  e.stopPropagation();
                  onCitationClick({ paperId: parsed.paperId, quote });
                }
              }}
            >
              {children}
            </span>
          );
        }
        // Invalid citation, unknown AuthorYear, external link, or no click
        // handler: drop the <a> wrapper, keep the text.
        return <>{children}</>;
      },
    }),
    [paperIdMapping, onCitationClick],
  );

  return (
    <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={components}>
      {markdown ?? ""}
    </ReactMarkdown>
  );
};
