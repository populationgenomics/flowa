/** YAML serialization for artifact editing — eliminates JSON escaping issues. */

import yaml from "yaml";
import type { Artifact } from "./artifact.js";

// ---------------------------------------------------------------------------
// Bbox cache — preserves pipeline-precomputed bboxes across edits
// ---------------------------------------------------------------------------

type Bbox = {
  page: number;
  top: number;
  left: number;
  bottom: number;
  right: number;
};

export type BboxCache = Map<string, Bbox[]>;

function cacheKey(paperId: string, quote: string): string {
  return `${paperId}\n${quote}`;
}

/** Extract (paperId, quote) → bboxes lookup from an artifact JSON string. */
export function buildBboxCache(jsonStr: string): BboxCache {
  const cache: BboxCache = new Map();
  const art = JSON.parse(jsonStr) as Artifact;
  for (const claim of art.claims ?? []) {
    for (const citation of claim.citations ?? []) {
      if (citation.bboxes?.length) {
        cache.set(cacheKey(claim.paper_id, citation.quote), citation.bboxes);
      }
    }
  }
  return cache;
}

/** Reattach cached bboxes to citations with matching (paperId, quote). Generic
 *  over the artifact type so deployment-specific fields survive the rebuild. */
export function reattachBboxes<T extends Artifact>(
  artifact: T,
  cache: BboxCache,
): T {
  return {
    ...artifact,
    claims: artifact.claims.map((claim) => ({
      ...claim,
      citations: claim.citations.map((citation) => {
        const bboxes = cache.get(cacheKey(claim.paper_id, citation.quote));
        return bboxes ? { ...citation, bboxes } : citation;
      }),
    })),
  };
}

// ---------------------------------------------------------------------------
// YAML serialization
// ---------------------------------------------------------------------------

/** Convert an artifact JSON string to YAML, stripping bboxes from claim citations. */
export function artifactToYaml(jsonStr: string): string {
  const art = JSON.parse(jsonStr) as Record<string, unknown>;
  if (Array.isArray(art.claims)) {
    art.claims = (art.claims as Record<string, unknown>[]).map((claim) => {
      const citations = Array.isArray(claim.citations)
        ? (claim.citations as Record<string, unknown>[]).map(
            ({ bboxes: _bboxes, ...rest }) => rest,
          )
        : claim.citations;
      return { ...claim, citations };
    });
  }
  return yaml.stringify(art, { lineWidth: 0 });
}

/** Parse a YAML artifact string back to a JS object. */
export function parseArtifactYaml(yamlStr: string): unknown {
  return yaml.parse(yamlStr);
}

// ---------------------------------------------------------------------------
// Artifact-text mutation
// ---------------------------------------------------------------------------

/**
 * Insert text after a specific line number (1-indexed).
 * Line 0 means insert at the beginning.
 */
export function insertAtLine(
  yamlStr: string,
  insertLine: number,
  insertText: string,
): string {
  const lines = yamlStr.split("\n");
  const idx = Math.max(0, Math.min(insertLine, lines.length));
  lines.splice(idx, 0, ...insertText.split("\n"));
  return lines.join("\n");
}
