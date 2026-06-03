/** YAML serialization for artifact editing — eliminates JSON escaping issues. */

import yaml from "yaml";
import type { Artifact } from "./artifact.js";

// ---------------------------------------------------------------------------
// Location cache — preserves a citation's pipeline-precomputed resolution
// (PDF bboxes + assembled markdown anchor) across edits. The model never sees this
// derived `location` field (it's stripped to YAML below); we reattach it to
// any citation whose (paperId, quote) survives the edit.
// ---------------------------------------------------------------------------

type Bbox = {
  page: number;
  top: number;
  left: number;
  bottom: number;
  right: number;
};

type MarkdownAnchor = { start: number; end: number };

type CitationLocation = {
  bboxes: Bbox[];
  markdown_anchor: MarkdownAnchor | null;
};

export type LocationCache = Map<string, CitationLocation>;

function cacheKey(paperId: string, quote: string): string {
  return `${paperId}\n${quote}`;
}

/** Extract (paperId, quote) → location lookup from an artifact JSON string. */
export function buildLocationCache(jsonStr: string): LocationCache {
  const cache: LocationCache = new Map();
  const art = JSON.parse(jsonStr) as Artifact;
  for (const claim of art.claims ?? []) {
    for (const citation of claim.citations ?? []) {
      if (citation.location) {
        cache.set(cacheKey(claim.paper_id, citation.quote), citation.location);
      }
    }
  }
  return cache;
}

/** Reattach cached locations to citations with matching (paperId, quote).
 *  Generic over the artifact type so deployment-specific fields survive the
 *  rebuild. */
export function reattachLocations<T extends Artifact>(
  artifact: T,
  cache: LocationCache,
): T {
  return {
    ...artifact,
    claims: artifact.claims.map((claim) => ({
      ...claim,
      citations: claim.citations.map((citation) => {
        const location = cache.get(cacheKey(claim.paper_id, citation.quote));
        return location ? { ...citation, location } : citation;
      }),
    })),
  };
}

// ---------------------------------------------------------------------------
// YAML serialization
// ---------------------------------------------------------------------------

/** Convert an artifact JSON string to YAML, stripping each citation's derived
 *  `location` (bboxes + markdown anchor) so the model edits only quotes. */
export function artifactToYaml(jsonStr: string): string {
  const art = JSON.parse(jsonStr) as Record<string, unknown>;
  if (Array.isArray(art.claims)) {
    art.claims = (art.claims as Record<string, unknown>[]).map((claim) => {
      const citations = Array.isArray(claim.citations)
        ? (claim.citations as Record<string, unknown>[]).map(
            ({ location: _location, ...rest }) => rest,
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
