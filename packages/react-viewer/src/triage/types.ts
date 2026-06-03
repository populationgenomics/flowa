/**
 * Triage workspace types. The shape of an artifact (what the LLM produces
 * and the curator triages) plus the per-claim triage state values.
 *
 * `WorkspaceKey` is opaque to the shell: backends use it as the primary key
 * for persisting triage state. Consumers encode whatever fields uniquely
 * identify the triage workspace for a given artifact version. The shell
 * never reads its fields — it only forwards the key to the backend.
 */

import type { ResolvedQuote } from "./citation-resolver";

/** Citation inside a claim. DOI is derived from the claim's paperId. */
export interface ClaimCitation {
  quote: string;
  /**
   * Where the quote resolved in the paper's sources — PDF bboxes and the
   * the assembled markdown anchor, as one `ResolvedQuote`. Absent on citations added
   * during editing (and on legacy aggregates); present on pipeline citations,
   * possibly with empty `bboxes` / null `markdownAnchor` when the quote was
   * found in only one source.
   */
  location?: ResolvedQuote | null;
}

/** A single factual statement extracted from a paper. The unit of triage. */
export interface Claim {
  paperId: string;
  text: string;
  citations: ClaimCitation[];
}

/**
 * A paper in the ranked papers list for a CategorySuggestion. List position
 * encodes importance (first = most important).
 */
export interface RankedPaper {
  paperId: string;
  rankRationale: string;
}

/**
 * Result for a single assessment category — the parsed view of one
 * `aggregation.json` entry under `results[]`. Mirrors the field shape
 * `@flowajs/chat-service` exposes via `artifactFields`. Deployments may
 * extend this shape with their own fields and pass the wider type to
 * the shell — TypeScript's structural compatibility accepts the
 * superset since the shell only reads the core fields.
 */
export interface CategorySuggestion {
  category: string;
  description: string;
  notes: string;
  papers: RankedPaper[];
  claims: Claim[];
}

/** Per-claim triage decision. */
export type TriageStateValue = "UNREVIEWED" | "ACCEPTED" | "REJECTED";

/**
 * Workspace key passed to a `TriageBackend`. Opaque to the shell; consumers
 * encode whatever uniquely identifies "the triage state for this artifact
 * version".
 */
export type WorkspaceKey = Record<string, string | number>;

/** A single artifact-version entry shown in the version dropdown. */
export interface VersionEntry {
  version: number;
  parentVersion: number | null;
  createdAt: Date;
  createdBy: string | null;
}
