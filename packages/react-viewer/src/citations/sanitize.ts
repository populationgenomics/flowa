// Citation-link helpers for the LLM-content renderer.
//
// SECURITY: Markdown rendering goes through react-markdown (see LlmContent /
// MarkdownHighlightViewer), which escapes raw HTML and URL-sanitizes hrefs by
// default — we never enable `rehype-raw`. So there is no separate HTML
// sanitization pass here; these helpers only *classify* citation hrefs so the
// renderer can turn `#cite:AuthorYear` links into clickable spans (validated
// against the paperIdMapping in LlmContent) and strip everything else to text.

const CITE_HREF_RE = /^#cite:(\w+)$/;

/** Returns true if href is a valid citation fragment: `#cite:AuthorYear` */
export function isCitationHref(href: string): boolean {
  return CITE_HREF_RE.test(href);
}

/** Parses `#cite:Cook2023` → `{ paperId: "Cook2023" }`, or null. */
export function parseCiteHref(href: string): { paperId: string } | null {
  const m = CITE_HREF_RE.exec(href);
  if (!m || !m[1]) return null;
  return { paperId: m[1] };
}

/**
 * Extract (paperId, quote) pairs from raw LLM Markdown text.
 *
 * Matches the citation link format: `[display text](#cite:paperId "quote")`
 * Used for batch-resolving chat citations to bboxes/anchors.
 */
export function parseCitationsFromMarkdown(
  markdown: string,
): { paperId: string; quote: string }[] {
  const re = /\[(?:[^\]]*)\]\(#cite:(\w+)\s+"([^"]+)"\)/g;
  const results: { paperId: string; quote: string }[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(markdown)) !== null) {
    results.push({ paperId: match[1]!, quote: match[2]! });
  }
  return results;
}
