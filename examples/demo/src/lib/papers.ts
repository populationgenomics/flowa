/**
 * Per-variant paper listing with derived statuses.
 *
 * The literature page wants to render every DOI flowa queried for a
 * variant — extracted / downloaded / awaiting-manual-upload — without
 * threading a separate paper-list manifest through the pipeline. The
 * status is purely a function of which files exist on disk:
 *
 *   - `extracted`     extractions/{encodedDoi}.json exists
 *   - `downloaded`    papers/{encodedDoi}/main.pdf exists but no extract
 *   - `needs_manual`  neither file exists (the curator must drop a PDF in)
 *
 * Mirrors what real consumers would derive from object storage. The
 * `queried` / `failed` statuses are reserved for future pipeline
 * instrumentation that distinguishes "queried but not yet attempted"
 * from "tried but failed"; for now nothing without a PDF is anything
 * other than `needs_manual`.
 */

import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
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
  /**
   * Stored supplement filenames (with their `NNN_` ingestion-order prefix),
   * sorted. Empty when the paper has no `supplements/` dir. The UI strips the
   * prefix for display.
   */
  supplements: string[];
}

export interface PapersForVariant {
  papers: PaperRow[];
  aggregateExists: boolean;
  categories: string[];
  /**
   * RefSeq transcript from `query.json`'s
   * `variant_spec.variants[0].transcript`. Null when the run died
   * before the query stage finished.
   */
  transcript: string | null;
  /**
   * c.-form HGVS expression (without transcript prefix) from
   * `query.json`'s `variant_spec.variants[0].hgvs_c`. Null when the
   * run died before the query stage finished. Callers that want the
   * full transcript-prefixed display form join `${transcript}:${hgvs_c}`.
   */
  hgvs_c: string | null;
}

interface QueryFile {
  variant_spec?: {
    variants?: { transcript?: string; hgvs_c?: string }[];
  };
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
    return {
      papers: [],
      aggregateExists: false,
      categories: [],
      transcript: null,
      hgvs_c: null,
    };
  }
  const query = JSON.parse(await readFile(queryPath, "utf8")) as QueryFile;
  const specItem = query.variant_spec?.variants?.[0];
  const transcript = specItem?.transcript ?? null;
  const hgvs_c = specItem?.hgvs_c ?? null;

  const aggregatePath = join(assessmentDir, "aggregation.json");
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
    const pdfPath = join(dataDir, "papers", encoded, "main.pdf");
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

    const supplementsDir = join(dataDir, "papers", encoded, "supplements");
    // Hide the convert-written `*.pdf.md` transcription sidecars; office + PDF
    // supplements the curator uploaded are shown.
    const supplements = existsSync(supplementsDir)
      ? (await readdir(supplementsDir))
          .sort()
          .filter((n) => !n.endsWith(".pdf.md"))
      : [];

    papers.push({
      doi,
      encodedDoi: encoded,
      status,
      title,
      authors,
      pmid,
      url: `https://doi.org/${doi}`,
      supplements,
    });
  }

  return {
    papers,
    aggregateExists,
    categories,
    transcript,
    hgvs_c,
  };
}
