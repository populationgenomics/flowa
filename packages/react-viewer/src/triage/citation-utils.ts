/**
 * Citation-level utilities: flatten a CategorySuggestion's per-claim citations
 * into a flat list keyed by DOI, and format paper labels for display.
 *
 * `encodeDoi` is the percent-encoding the demo (and any consumer that names
 * paper directories by DOI) needs to keep paths stable: encodes `!'()*` in
 * addition to what `encodeURIComponent` covers, matching Python's
 * `urllib.parse.quote(doi, safe='')`.
 */

import type { PaperIdMapping } from "../citations/types";
import type { CategorySuggestion, ClaimCitation } from "./types";

/** A citation enriched with the DOI of its owning paper. */
export interface FlatCitation {
  doi: string;
  paperId: string;
  quote: string;
  bboxes: NonNullable<ClaimCitation["bboxes"]>;
  /** The owning claim's position within its paper's claims run (1-based). */
  claimIndex: number;
  /** The owning claim's text, for tooltips / search. */
  claimText: string;
}

/**
 * Flatten a CategorySuggestion's claim citations into an array where each
 * entry carries the owning paper's DOI. Used by viewers that render a flat
 * citation list or iterate across the whole set (e.g. PDF-highlight ingestion,
 * resolution preloading).
 */
export function flattenClaimCitations(
  suggestion: CategorySuggestion,
  mapping: PaperIdMapping | undefined,
): FlatCitation[] {
  const out: FlatCitation[] = [];
  let runIndex = 0;
  let lastPaper: string | null = null;
  for (const claim of suggestion.claims) {
    if (claim.paperId !== lastPaper) {
      runIndex = 0;
      lastPaper = claim.paperId;
    }
    runIndex += 1;
    const doi = mapping?.byAuthorYear[claim.paperId]?.doi;
    if (!doi) continue;
    for (const citation of claim.citations) {
      out.push({
        doi,
        paperId: claim.paperId,
        quote: citation.quote,
        bboxes: citation.bboxes ?? [],
        claimIndex: runIndex,
        claimText: claim.text,
      });
    }
  }
  return out;
}

/**
 * Format a paper label as `Author2024 (PMID 12345)` or
 * `Author2024 (10.1038/...)`. Falls back to the DOI / PMID alone when no
 * AuthorYear mapping is known.
 */
export function formatPaperLabel(
  doi: string,
  pmid: number | undefined,
  mapping: PaperIdMapping | undefined,
): string {
  const authorYear = mapping?.byDoi[doi];
  const idSuffix = pmid ? `PMID ${pmid}` : doi;
  return authorYear ? `${authorYear} (${idSuffix})` : idSuffix;
}

/**
 * Percent-encode a DOI for safe use in URL paths and S3-style keys (RFC 3986
 * strict encoding). `encodeURIComponent` leaves `!'()*` unencoded; we encode
 * those too so the result matches Python's `urllib.parse.quote(doi, safe='')`.
 */
export function encodeDoi(doi: string): string {
  return encodeURIComponent(doi).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}
