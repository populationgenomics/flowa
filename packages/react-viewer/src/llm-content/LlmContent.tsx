import { useMemo, type FC } from "react";
import parse, { type DOMNode, Element, domToReact } from "html-react-parser";
import { sanitizeLlmMarkdown, parseCiteHref } from "../citations/sanitize";
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
   * title attribute (used for highlight resolution).
   */
  onCitationClick?: (parsed: { paperId: string; quote: string }) => void;
}

/**
 * Renders LLM-generated Markdown with citation link handling.
 *
 * Pipeline: Markdown → sanitizeLlmMarkdown (marked + DOMPurify + link validation)
 * → html-react-parser (converts validated #cite: links to clickable spans).
 */
export const LlmContent: FC<LlmContentProps> = ({
  markdown,
  paperIdMapping,
  onCitationClick,
}) => {
  const html = useMemo(
    () => sanitizeLlmMarkdown(markdown ?? "", paperIdMapping),
    [markdown, paperIdMapping],
  );

  const elements = parse(html, {
    replace: (domNode) => {
      if (domNode instanceof Element && domNode.name === "a") {
        const parsed = parseCiteHref(domNode.attribs?.href ?? "");
        const quote = domNode.attribs?.title ?? "";
        if (parsed && onCitationClick) {
          // Validated citation — render as a <span> so it flows inline with
          // surrounding text (a <button> creates an atomic inline box that
          // prevents adjacent punctuation from staying on the same line).
          return (
            <span
              role="button"
              tabIndex={0}
              data-testid="citation-link"
              className="cursor-pointer text-cyan-700 hover:text-cyan-900 hover:underline"
              onClick={(e) => {
                e.stopPropagation();
                onCitationClick({ ...parsed, quote });
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  e.stopPropagation();
                  onCitationClick({ ...parsed, quote });
                }
              }}
            >
              {domToReact(domNode.children as DOMNode[])}
            </span>
          );
        }
        // No click handler — strip <a> to plain text
        return <>{domToReact(domNode.children as DOMNode[])}</>;
      }
    },
  });

  return <>{elements}</>;
};
