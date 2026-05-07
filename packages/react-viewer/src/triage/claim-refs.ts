/**
 * Helpers for resolving a prose citation (paperId + verbatim quote) to the
 * backing claim's position within a CategorySuggestion.claims[] array.
 *
 * The claim reference `(paperId, claimIndex)` is the unit of triage: it
 * backs triage backend FKs, optimistic store keys, and the focused-card
 * cursor. It never crosses a service boundary to the LLM.
 */

import type { Claim } from "./types";

export interface ClaimRef {
  paperId: string;
  /** 1-based position within this paper's run of claims[]. */
  claimIndex: number;
}

/**
 * Group claims by paperId, preserving the order of first appearance. Returns
 * a map from paperId to the claims in that paper, in their original order.
 */
export function groupClaimsByPaper(
  claims: readonly Claim[],
): Map<string, Claim[]> {
  const map = new Map<string, Claim[]>();
  for (const claim of claims) {
    let group = map.get(claim.paperId);
    if (!group) {
      group = [];
      map.set(claim.paperId, group);
    }
    group.push(claim);
  }
  return map;
}

/**
 * Resolve (paperId, quote) from a prose citation to (paperId, claimIndex).
 *
 * Lookup rules:
 *  1. Exact match: paperId matches AND the quote is one of the claim's
 *     citations[].quote values.
 *  2. Fuzzy fallback: longest-common-prefix match within the paper's claims.
 *     Tolerates minor paraphrase drift.
 *  3. Ambiguous or no match → returns null.
 */
export function resolveClaimForCitation(
  paperId: string,
  quote: string,
  claims: readonly Claim[],
): ClaimRef | null {
  const paperClaims: { claim: Claim; index: number }[] = [];
  let runIndex = 0;
  let lastPaper: string | null = null;
  for (const claim of claims) {
    if (claim.paperId !== lastPaper) {
      runIndex = 0;
      lastPaper = claim.paperId;
    }
    runIndex += 1;
    if (claim.paperId === paperId) {
      paperClaims.push({ claim, index: runIndex });
    }
  }
  if (paperClaims.length === 0) return null;

  const trimmed = quote.trim();

  for (const { claim, index } of paperClaims) {
    for (const citation of claim.citations) {
      if (citation.quote === quote) return { paperId, claimIndex: index };
      if (citation.quote.trim() === trimmed)
        return { paperId, claimIndex: index };
    }
  }

  let bestIdx: number | null = null;
  let bestPrefix = 0;
  for (const { claim, index } of paperClaims) {
    for (const citation of claim.citations) {
      const p = commonPrefixLength(citation.quote, quote);
      if (p > bestPrefix && p >= 40) {
        bestPrefix = p;
        bestIdx = index;
      }
    }
  }
  if (bestIdx != null) return { paperId, claimIndex: bestIdx };
  return null;
}

function commonPrefixLength(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

/**
 * Build a lookup keyed by `paperId\n<text>` for O(1) carry-over queries
 * when triage state needs to be re-mapped after an artifact rewrite (the
 * claim index moves; the (paperId, text) pair is the stable identity).
 */
export function indexClaimsByPaperIdAndText(
  claims: readonly Claim[],
): Map<string, ClaimRef> {
  const out = new Map<string, ClaimRef>();
  let runIndex = 0;
  let lastPaper: string | null = null;
  for (const claim of claims) {
    if (claim.paperId !== lastPaper) {
      runIndex = 0;
      lastPaper = claim.paperId;
    }
    runIndex += 1;
    out.set(`${claim.paperId}\n${claim.text}`, {
      paperId: claim.paperId,
      claimIndex: runIndex,
    });
  }
  return out;
}
