/**
 * Per-variant paper listing with derived statuses.
 *
 * The literature page wants to render every DOI flowa queried for a
 * variant — extracted / downloaded / awaiting-manual-upload — without
 * threading a separate paper-list manifest through the pipeline. The
 * status is purely a function of which files exist on disk:
 *
 *   - `extracted`     extractions/{encodedDoi}.json exists
 *   - `downloaded`    papers/{encodedDoi}/source.pdf exists but no extract
 *   - `needs_manual`  neither file exists (the curator must drop a PDF in)
 *
 * Mirrors what real consumers would derive from object storage. The
 * `queried` / `failed` statuses are reserved for future pipeline
 * instrumentation that distinguishes "queried but not yet attempted"
 * from "tried but failed"; for now nothing without a PDF is anything
 * other than `needs_manual`.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { encodeDoi } from "@flowajs/react-viewer";
import { getDemoDataDir } from "./demoConfig";

export type PaperStatus =
  | "extracted"
  | "downloaded"
  | "needs_manual"
  | "queried"
  | "failed";

export interface PaperRow {
  doi: string;
  encodedDoi: string;
  status: PaperStatus;
  title: string | null;
  authors: string | null;
  pmid: number | null;
  /** DOI-resolved URL. Always present (DOI is mandatory in `query.json`). */
  url: string;
}

export interface PapersForVariant {
  papers: PaperRow[];
  aggregateExists: boolean;
  categories: string[];
}

interface QueryFile {
  dois: string[];
}

interface PaperMetadata {
  title?: string;
  authors?: string;
  pmid?: number;
}

interface AggregateFile {
  results?: Array<{ category: string }>;
}

export async function listPapersForVariant(
  variantId: string,
  options: { dataDir?: string } = {},
): Promise<PapersForVariant> {
  const dataDir = options.dataDir ?? getDemoDataDir();
  const assessmentDir = join(dataDir, "assessments", variantId);

  // Query stage hasn't run → nothing to list yet.
  const queryPath = join(assessmentDir, "query.json");
  if (!existsSync(queryPath)) {
    return { papers: [], aggregateExists: false, categories: [] };
  }
  const query = JSON.parse(await readFile(queryPath, "utf8")) as QueryFile;

  const aggregatePath = join(assessmentDir, "aggregate.json");
  let aggregateExists = false;
  let categories: string[] = [];
  if (existsSync(aggregatePath)) {
    aggregateExists = true;
    const agg = JSON.parse(
      await readFile(aggregatePath, "utf8"),
    ) as AggregateFile;
    categories = (agg.results ?? []).map((r) => r.category);
  }

  const papers: PaperRow[] = [];
  for (const doi of query.dois) {
    const encoded = encodeDoi(doi);
    const pdfPath = join(dataDir, "papers", encoded, "source.pdf");
    const extractPath = join(assessmentDir, "extractions", `${encoded}.json`);

    let status: PaperStatus;
    if (existsSync(extractPath)) {
      status = "extracted";
    } else if (existsSync(pdfPath)) {
      status = "downloaded";
    } else {
      status = "needs_manual";
    }

    const metaPath = join(dataDir, "papers", encoded, "metadata.json");
    let title: string | null = null;
    let authors: string | null = null;
    let pmid: number | null = null;
    if (existsSync(metaPath)) {
      const m = JSON.parse(await readFile(metaPath, "utf8")) as PaperMetadata;
      title = m.title ?? null;
      authors = m.authors ?? null;
      pmid = m.pmid ?? null;
    }

    papers.push({
      doi,
      encodedDoi: encoded,
      status,
      title,
      authors,
      pmid,
      url: `https://doi.org/${doi}`,
    });
  }

  return { papers, aggregateExists, categories };
}
