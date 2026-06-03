/**
 * Server-side invalidation of a paper's derived pipeline data.
 *
 * The flowa pipeline caches by output-file presence: `convert` and `extract`
 * skip a paper whose output already exists (`aggregate` alone always
 * overwrites). So a change to a paper's inputs only takes effect on the next
 * run if the now-stale derived data is deleted first. A curator therefore
 * invalidates here after changing a paper's PDF or supplements, then re-runs the
 * analysis to regenerate it.
 *
 * Three gradients, by what changed (cheapest first):
 *   - office supplement  → only `merged.md` is stale (re-assemble, no LLM).
 *   - PDF supplement     → the merged PDF + its index + `merged.md` are stale;
 *                          the per-piece transcriptions (`main.md`, sidecars) survive,
 *                          so convert re-transcribes only the new supplement.
 *   - main PDF           → everything derived, including `main.md`, is stale.
 *
 * `merged.md` is always invalidated (the LLM read it, so the assessment's
 * extraction is stale too). Scoped to one assessment for the extraction: other
 * assessments referencing the same paper keep their (now stale) extractions until
 * they are themselves re-run. Best-effort — a missing file is not an error.
 * `aggregation.json` is left alone — `aggregate` has no presence cache and
 * overwrites it on every run.
 */

import { rm } from "node:fs/promises";
import { join } from "node:path";
import { encodeDoi } from "@flowajs/react-viewer";

async function invalidate(
  dataDir: string,
  doi: string,
  variantId: string | undefined,
  paperFiles: string[],
): Promise<void> {
  const encoded = encodeDoi(doi);
  const targets = paperFiles.map((f) => join(dataDir, "papers", encoded, f));
  if (variantId) {
    const extractions = join(dataDir, "assessments", variantId, "extractions");
    targets.push(
      join(extractions, `${encoded}.json`),
      join(extractions, `${encoded}_raw.json`),
    );
  }
  await Promise.all(targets.map((t) => rm(t, { force: true })));
}

/**
 * An **office** supplement (xlsx/docx) changed. Only `merged.md` is stale —
 * `main.md` / `merged.pdf` / `pdf_index` are untouched, so the next convert
 * re-assembles `merged.md` (markitdown only) and skips the vision-LLM entirely.
 */
export function invalidatePaperDerivedData(
  dataDir: string,
  doi: string,
  variantId?: string,
): Promise<void> {
  return invalidate(dataDir, doi, variantId, ["merged.md"]);
}

/**
 * A **PDF** supplement was added or removed. The merged PDF, its index, and
 * `merged.md` are stale; `main.md` and the other supplements' transcription
 * sidecars survive, so convert re-transcribes only the changed supplement,
 * re-merges, re-indexes, and re-assembles. (The removed supplement's own `.pdf`
 * and `.pdf.md` sidecar are deleted by the supplements route.)
 */
export function invalidatePdfSupplementChange(
  dataDir: string,
  doi: string,
  variantId?: string,
): Promise<void> {
  return invalidate(dataDir, doi, variantId, [
    "merged.pdf",
    "pdf_index.pkl.zst",
    "merged.md",
  ]);
}

/**
 * The **main** PDF changed. Everything derived from it is stale, including
 * `main.md` (so convert re-transcribes the main paper). The PDF supplements'
 * sidecars are main-independent and survive.
 */
export function invalidateMainPdfChange(
  dataDir: string,
  doi: string,
  variantId?: string,
): Promise<void> {
  return invalidate(dataDir, doi, variantId, [
    "main.md",
    "merged.pdf",
    "pdf_index.pkl.zst",
    "merged.md",
  ]);
}
