// SECURITY: LLM output is untrusted. This module provides a single sanitization
// pipeline for ALL LLM-generated Markdown: marked → DOMPurify → link validation.
// All links are stripped EXCEPT citation links matching #cite:AuthorYear whose
// AuthorYear resolves to a known paper in the paperIdMapping. The title attribute
// carries the verbatim quote for highlight resolution. Everything downstream of
// sanitizeLlmMarkdown() can treat the output as trusted.

import { marked } from "marked";
import DOMPurify from "dompurify";
import type { PaperIdMapping } from "./types";

// Keep GFM enabled (for tables, etc.) but disable strikethrough so that
// tildes in scientific text (e.g. "~22 years") render as plain text.
// Override the built-in tokenizer method, not the extensions array —
// "del" is a built-in GFM rule, not a custom extension.
marked.use({
  tokenizer: {
    del() {
      return undefined;
    },
  },
});

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
 * Used for batch-resolving chat citations to bboxes.
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

/**
 * Strips all `<a>` tags that fail syntactic or semantic validation.
 *
 * Syntactic: href must match `#cite:AuthorYear`.
 * Semantic: AuthorYear must exist in paperIdMapping.
 *
 * The `title` attribute (carrying the verbatim quote) is preserved on valid links.
 * Invalid links are unwrapped: text content preserved, `<a>` wrapper removed.
 */
export function stripInvalidLinks(
  html: string,
  paperIdMapping: PaperIdMapping,
): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("a").forEach((a) => {
    const href = a.getAttribute("href") ?? "";
    const parsed = parseCiteHref(href);
    if (!parsed) {
      a.replaceWith(a.textContent ?? "");
      return;
    }
    if (!paperIdMapping.byAuthorYear[parsed.paperId]) {
      a.replaceWith(a.textContent ?? "");
    }
  });
  return doc.body.innerHTML;
}

/**
 * Single sanitization pipeline for LLM-generated Markdown.
 *
 * 1. Escape `|` inside link title attributes (prevents breaking GFM table parsing)
 * 2. `marked.parse()` — Markdown → HTML
 * 3. `DOMPurify.sanitize()` — strips dangerous tags/attributes
 * 4. `stripInvalidLinks()` — removes all links except validated citations
 *
 * Returns safe HTML ready for `html-react-parser` or any HTML consumer.
 */
export function sanitizeLlmMarkdown(
  markdown: string,
  paperIdMapping: PaperIdMapping,
): string {
  // Escape pipe characters inside link title attributes so they don't get
  // interpreted as GFM table cell delimiters by marked's tokenizer.
  // html-react-parser decodes &#124; back to | when reading attributes.
  const preprocessed = markdown.replace(
    /\[([^\]]*)\]\(([^)"]*)\s+"([^"]*)"\)/g,
    (_, text: string, url: string, title: string) =>
      `[${text}](${url} "${title.replace(/\|/g, "&#124;")}")`,
  );
  // marked.parse() is sync when no async extensions are registered
  const rawHtml = marked.parse(preprocessed) as string;
  const clean = DOMPurify.sanitize(rawHtml.trim(), {
    ADD_ATTR: ["title"],
  });
  return stripInvalidLinks(clean, paperIdMapping);
}
