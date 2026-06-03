/**
 * Server-side helpers for loading + parsing the demo's aggregate artifacts
 * from local storage. Translates the on-disk snake_case shape produced by
 * flowa's aggregate stage into the camelCase `CategorySuggestion` /
 * `PaperIdMapping` shapes the viewer shell renders.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  CategorySuggestion,
  Claim,
  PaperIdMapping,
  RankedPaper,
} from "@flowajs/react-viewer";
import { getDemoDataDir } from "./demoConfig";

interface RawCitation {
  quote: string;
  /**
   * The quote's resolved location: PDF bboxes + merged.md anchor. Null when
   * the paper's artifacts were unavailable; absent on citations added during
   * editing.
   */
  location?: {
    bboxes: Array<{
      page: number;
      top: number;
      left: number;
      bottom: number;
      right: number;
    }>;
    markdown_anchor: { start: number; end: number } | null;
  } | null;
}

interface RawClaim {
  paper_id: string;
  text: string;
  citations: RawCitation[];
}

interface RawRankedPaper {
  paper_id: string;
  rank_rationale: string;
}

interface RawCategoryResult {
  category: string;
  classification: string;
  classification_rationale: string;
  description: string;
  notes: string;
  papers: RawRankedPaper[];
  claims: RawClaim[];
}

interface RawAggregate {
  schema_version?: number;
  results: RawCategoryResult[];
  paper_id_mapping?: Record<string, { doi: string; pmid?: number }>;
}

export interface LoadedAggregate {
  artifact: CategorySuggestion;
  paperIdMapping: PaperIdMapping;
  artifactText: string;
  rawCategory: RawCategoryResult;
}

export interface LoadAggregateOptions {
  /** Override storage root (defaults to `getDemoDataDir()`). */
  dataDir?: string;
}

function toClaim(raw: RawClaim): Claim {
  return {
    paperId: raw.paper_id,
    text: raw.text,
    citations: raw.citations.map((c) => ({
      quote: c.quote,
      location: c.location
        ? {
            bboxes: c.location.bboxes,
            markdownAnchor: c.location.markdown_anchor,
          }
        : undefined,
    })),
  };
}

function toRankedPaper(raw: RawRankedPaper): RankedPaper {
  return {
    paperId: raw.paper_id,
    rankRationale: raw.rank_rationale,
  };
}

function toCategorySuggestion(raw: RawCategoryResult): CategorySuggestion {
  return {
    category: raw.category,
    description: raw.description,
    notes: raw.notes,
    papers: raw.papers.map(toRankedPaper),
    claims: raw.claims.map(toClaim),
  };
}

/**
 * Build a `PaperIdMapping` from the on-disk shape. The aggregate file may
 * carry `paper_id_mapping` directly (the pipeline currently writes it);
 * fall back to deriving from per-paper metadata files when absent.
 */
async function buildPaperIdMapping(
  dataDir: string,
  raw: RawAggregate,
): Promise<PaperIdMapping> {
  if (raw.paper_id_mapping && Object.keys(raw.paper_id_mapping).length > 0) {
    const byAuthorYear = raw.paper_id_mapping;
    const byDoi: Record<string, string> = {};
    for (const [authorYear, entry] of Object.entries(byAuthorYear)) {
      byDoi[entry.doi] = authorYear;
    }
    return { byAuthorYear, byDoi };
  }

  // Fallback: scan per-paper metadata.json. Build AuthorYear from
  // first-author surname + publication year. Best-effort — only used
  // when the on-disk aggregate omits the mapping.
  const byAuthorYear: Record<string, { doi: string; pmid?: number }> = {};
  const byDoi: Record<string, string> = {};
  const paperIds = new Set<string>();
  for (const c of raw.results) {
    for (const claim of c.claims) paperIds.add(claim.paper_id);
    for (const p of c.papers) paperIds.add(p.paper_id);
  }
  // Without DOIs from aggregate, we have to scan the papers/ tree.
  // Read every paper's metadata.json and try to match its derived
  // AuthorYear against the artifact's referenced paperIds.
  const papersDir = join(dataDir, "papers");
  if (!existsSync(papersDir)) return { byAuthorYear, byDoi };
  const entries = await readdir(papersDir);
  for (const encodedDoi of entries) {
    const meta = join(papersDir, encodedDoi, "metadata.json");
    if (!existsSync(meta)) continue;
    const m = JSON.parse(await readFile(meta, "utf8")) as {
      doi: string;
      pmid?: number;
      authors: string;
      date: string;
    };
    const surname = m.authors.split(/[,;]/)[0]?.trim() ?? "";
    const year = m.date.slice(0, 4);
    const authorYear = `${surname}${year}`;
    if (paperIds.has(authorYear)) {
      byAuthorYear[authorYear] = { doi: m.doi, pmid: m.pmid };
      byDoi[m.doi] = authorYear;
    }
  }
  return { byAuthorYear, byDoi };
}

export async function loadAggregate(
  variantId: string,
  category: string,
  options: LoadAggregateOptions = {},
): Promise<LoadedAggregate | null> {
  const dataDir = options.dataDir ?? getDemoDataDir();
  const path = join(dataDir, "assessments", variantId, "aggregation.json");
  if (!existsSync(path)) return null;
  const fileText = await readFile(path, "utf8");
  const raw = JSON.parse(fileText) as RawAggregate;
  const rawCategory = raw.results.find((r) => r.category === category);
  if (!rawCategory) return null;
  const paperIdMapping = await buildPaperIdMapping(dataDir, raw);
  // chat-service stores artifacts per-category (one CategoryResult) and
  // expects `initial_artifact` to match that shape, not the multi-category
  // wrapper. Stringify the matching entry so the consumer can pass it
  // straight through to the chat session factory + the download button.
  const artifactText = JSON.stringify(rawCategory, null, 2);
  return {
    artifact: toCategorySuggestion(rawCategory),
    paperIdMapping,
    artifactText,
    rawCategory,
  };
}

/**
 * Same shape as `loadAggregate`, but reads from a specific edit-draft file
 * rather than the pipeline's `aggregation.json`. Used when the user picks a
 * post-pipeline version (v >= 1) from the dropdown.
 *
 * Edit-draft files live at `edit-drafts/{variantId}/{category}/artifact-v{N}.json`
 * and contain the **single** CategoryResult for that category (chat-service
 * writes drafts per-category, not as a multi-category aggregate).
 */
export async function loadEditDraft(
  variantId: string,
  category: string,
  version: number,
  options: LoadAggregateOptions = {},
): Promise<LoadedAggregate | null> {
  if (version < 1) return null;
  const dataDir = options.dataDir ?? getDemoDataDir();
  const path = join(
    dataDir,
    "edit-drafts",
    variantId,
    category,
    `artifact-v${version}.json`,
  );
  if (!existsSync(path)) return null;
  const artifactText = await readFile(path, "utf8");
  const rawCategory = JSON.parse(artifactText) as RawCategoryResult;
  // Edit drafts don't ship paper_id_mapping; reuse the pipeline aggregate's.
  // Read from the same dataDir.
  const aggPath = join(dataDir, "assessments", variantId, "aggregation.json");
  let paperIdMapping: PaperIdMapping = { byAuthorYear: {}, byDoi: {} };
  if (existsSync(aggPath)) {
    const rawAgg = JSON.parse(await readFile(aggPath, "utf8")) as RawAggregate;
    paperIdMapping = await buildPaperIdMapping(dataDir, rawAgg);
  }
  return {
    artifact: toCategorySuggestion(rawCategory),
    paperIdMapping,
    artifactText,
    rawCategory,
  };
}

/**
 * List edit-draft versions for a (variantId, category). v0 is the pipeline
 * output (`aggregation.json`), present iff that file exists; v1+ are
 * `artifact-v{N}.json` files under `edit-drafts/{variantId}/{category}/`.
 */
export interface VersionListEntry {
  version: number;
  /** ISO 8601 mtime; the demo's surrogate for "createdAt". */
  createdAt: string;
}

export async function listVersions(
  variantId: string,
  category: string,
  options: LoadAggregateOptions = {},
): Promise<VersionListEntry[]> {
  const dataDir = options.dataDir ?? getDemoDataDir();
  const out: VersionListEntry[] = [];

  const aggPath = join(dataDir, "assessments", variantId, "aggregation.json");
  if (existsSync(aggPath)) {
    const s = await stat(aggPath);
    out.push({ version: 0, createdAt: s.mtime.toISOString() });
  }

  const draftsDir = join(dataDir, "edit-drafts", variantId, category);
  if (existsSync(draftsDir)) {
    for (const name of await readdir(draftsDir)) {
      const m = name.match(/^artifact-v(\d+)\.json$/);
      if (!m) continue;
      const version = Number.parseInt(m[1]!, 10);
      const s = await stat(join(draftsDir, name));
      out.push({ version, createdAt: s.mtime.toISOString() });
    }
  }

  out.sort((a, b) => a.version - b.version);
  return out;
}
