/**
 * Callback contract for resolving chat-introduced citations to highlight
 * positions. The chat surface can introduce citations the pipeline never saw
 * (the LLM cites a quote we have no pre-computed bbox/anchor for); the shell
 * calls this resolver to obtain them on demand.
 *
 * Each resolved quote carries a `ResolvedQuote` (PDF `bboxes` + a `markdownAnchor`),
 * mirroring `flowa.resolve.ResolvedQuote`. Three distinct "no highlight" cases
 * the wire format separates:
 *  - `bboxes: []` for `resolved[doi][quote]` — the quote was searched for but
 *    could not be aligned in the PDF. The viewer surfaces "Could not locate
 *    quote" for the PDF pane.
 *  - `markdownAnchor: null` — the quote could not be located in the assembled markdown.
 *  - Entry in `errors[doi]` — neither the PDF index nor the assembled markdown was
 *    available for the paper; its quotes are absent from `resolved`. Consumers
 *    may surface this differently from a quote-not-found case.
 */

import type { HighlightBbox } from "../pdf-viewer/types";
import type { CodePointAnchor } from "../markdown-viewer/types";

export interface CitationQuery {
  doi: string;
  quotes: string[];
}

/**
 * Where a quote landed in a paper: PDF bboxes and/or a the assembled markdown anchor.
 * Mirrors `flowa.resolve.ResolvedQuote` (wire keys `bboxes`, `markdown_anchor`).
 */
export interface ResolvedQuote {
  bboxes: HighlightBbox[];
  markdownAnchor: CodePointAnchor | null;
}

export interface ResolvedCitations {
  resolved: Record<string, Record<string, ResolvedQuote>>;
  errors: Record<string, string>;
}

export type CitationResolver = (
  citations: CitationQuery[],
) => Promise<ResolvedCitations>;
