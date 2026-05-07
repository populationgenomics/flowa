/**
 * Callback contract for resolving chat-introduced citations to PDF bbox
 * positions. The chat surface can introduce citations the pipeline never
 * saw (the LLM cites a quote we don't have a pre-computed bbox for); the
 * shell calls this resolver to obtain bboxes on demand.
 *
 * Two distinct "no highlight" cases the wire format separates:
 *  - Empty array for `resolved[doi][quote]` — the quote was searched for
 *    but could not be aligned in the PDF. The viewer surfaces this as the
 *    "Could not locate quote" warning.
 *  - Entry in `errors[doi]` — the source PDF itself was not available.
 *    Quotes for that DOI are absent from `resolved`. Consumers may surface
 *    this differently from a quote-not-found case.
 */

import type { HighlightBbox } from "../pdf-viewer/types";

export interface CitationQuery {
  doi: string;
  quotes: string[];
}

export interface ResolvedCitations {
  resolved: Record<string, Record<string, HighlightBbox[]>>;
  errors: Record<string, string>;
}

export type CitationResolver = (
  citations: CitationQuery[],
) => Promise<ResolvedCitations>;
