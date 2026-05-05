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
// Line-numbered display (mirrors Claude's text editor tool)
// ---------------------------------------------------------------------------

/** Add 1-indexed line numbers to YAML for display. */
export function addLineNumbers(yamlStr: string): string {
  const lines = yamlStr.split("\n");
  const width = String(lines.length).length;
  return lines
    .map((line, i) => `${String(i + 1).padStart(width)}\t${line}`)
    .join("\n");
}

/**
 * Extract a line range from YAML and return with line numbers.
 * Uses 1-indexed lines; end=-1 means end of file.
 */
export function viewRange(yamlStr: string, start: number, end: number): string {
  const lines = yamlStr.split("\n");
  const s = Math.max(1, start);
  const e = end === -1 ? lines.length : Math.min(end, lines.length);
  const width = String(e).length;
  return lines
    .slice(s - 1, e)
    .map((line, i) => `${String(s + i).padStart(width)}\t${line}`)
    .join("\n");
}

/**
 * Find lines containing a literal substring. Returns matches with one line
 * of context either side; adjacent or overlapping blocks are merged and
 * separated by "--".
 */
export function searchArtifact(
  yamlStr: string,
  pattern: string,
): { output: string; count: number } {
  if (!pattern) return { output: "", count: 0 };
  const lines = yamlStr.split("\n");
  const hits: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]?.includes(pattern)) hits.push(i);
  }
  if (hits.length === 0) return { output: "", count: 0 };

  const ranges: [number, number][] = [];
  for (const i of hits) {
    const start = Math.max(0, i - 1);
    const end = Math.min(lines.length - 1, i + 1);
    const last = ranges[ranges.length - 1];
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else ranges.push([start, end]);
  }

  const width = String(lines.length).length;
  const blocks = ranges.map(([s, e]) =>
    lines
      .slice(s, e + 1)
      .map((line, i) => `${String(s + 1 + i).padStart(width)}\t${line}`)
      .join("\n"),
  );
  return { output: blocks.join("\n--\n"), count: hits.length };
}

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
