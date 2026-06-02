/**
 * Server-side invalidation of a paper's derived pipeline data.
 *
 * The flowa pipeline caches by output-file presence: `convert` and `extract`
 * skip a paper whose output already exists (`aggregate` alone always
 * overwrites). So a change to a paper's inputs only takes effect on the next
 * run if the now-stale derived data is deleted first. A curator therefore
 * invalidates here after changing a paper's supplements, then re-runs the
 * analysis to regenerate it.
 */

import { rm } from "node:fs/promises";
import { join } from "node:path";
import { encodeDoi } from "@flowajs/react-viewer";

/**
 * Invalidate the derived data a **supplement** change makes stale.
 *
 * A supplement change leaves `source.pdf` untouched, so `source.md` (the
 * vision-LLM transcription) and `pdf_index.pkl.zst` (the bbox index) stay valid
 * and are kept. Only:
 *   - `papers/{doi}/markdown.md` — assembled from source.md + supplements;
 *     deleting it makes the next `convert` re-assemble it (folding in the new
 *     supplement) while *skipping* the expensive vision-LLM, since source.md
 *     survives.
 *   - `assessments/{variantId}/extractions/{doi}.json` (+ `_raw`) — the LLM
 *     read markdown.md, so its extraction is stale; deleting it forces a
 *     re-extract on the next run.
 * are removed. `aggregation.json` is left alone — `aggregate` has no presence
 * cache and overwrites it on every run.
 *
 * Scoped to one assessment: other assessments referencing the same paper keep
 * their (now stale) extractions until they are themselves re-run; the
 * paper-global markdown.md is invalidated for all of them. Best-effort — a
 * missing file is not an error.
 */
export async function invalidatePaperDerivedData(
  dataDir: string,
  doi: string,
  variantId?: string,
): Promise<void> {
  const encoded = encodeDoi(doi);
  const targets = [join(dataDir, "papers", encoded, "markdown.md")];
  if (variantId) {
    const extractions = join(dataDir, "assessments", variantId, "extractions");
    targets.push(
      join(extractions, `${encoded}.json`),
      join(extractions, `${encoded}_raw.json`),
    );
  }
  await Promise.all(targets.map((t) => rm(t, { force: true })));
}
