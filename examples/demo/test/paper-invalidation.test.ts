/**
 * Tests for the paper-invalidation gradients.
 *
 * Locks the keep/delete contract each change relies on:
 *   - office supplement → only merged.md (+ extractions) go; the transcriptions
 *     (main.md), merged.pdf and its index survive.
 *   - PDF supplement → merged.pdf + pdf_index + merged.md go; main.md and the
 *     other supplements' sidecars survive.
 *   - main PDF → the above plus main.md.
 * aggregation.json always survives (aggregate overwrites it every run).
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeDoi } from "@flowajs/react-viewer";
import {
  invalidateMainPdfChange,
  invalidatePaperDerivedData,
  invalidatePdfSupplementChange,
} from "../src/lib/paperInvalidation";

const DOI = "10.1038/s41598-022-25914-8";
const VARIANT = "NM_000152_5-c_1935C_A";

let dataRoot: string;

interface Seeded {
  paperDir: string;
  extractionsDir: string;
  aggregation: string;
  encoded: string;
}

function seed(): Seeded {
  const encoded = encodeDoi(DOI);
  const paperDir = join(dataRoot, "papers", encoded);
  const assessmentDir = join(dataRoot, "assessments", VARIANT);
  const extractionsDir = join(assessmentDir, "extractions");
  mkdirSync(join(paperDir, "supplements"), { recursive: true });
  mkdirSync(extractionsDir, { recursive: true });
  writeFileSync(join(paperDir, "main.md"), "transcription");
  writeFileSync(join(paperDir, "merged.pdf"), "merged-pdf-bytes");
  writeFileSync(join(paperDir, "merged.md"), "transcription + supplement");
  writeFileSync(join(paperDir, "pdf_index.pkl.zst"), "binary-index");
  writeFileSync(
    join(paperDir, "supplements", "000_s.pdf.md"),
    "supp transcript",
  );
  writeFileSync(join(extractionsDir, `${encoded}.json`), "{}");
  writeFileSync(join(extractionsDir, `${encoded}_raw.json`), "{}");
  const aggregation = join(assessmentDir, "aggregation.json");
  writeFileSync(aggregation, "{}");
  return { paperDir, extractionsDir, aggregation, encoded };
}

beforeEach(() => {
  dataRoot = mkdtempSync(join(tmpdir(), "flowa-demo-invalidation-"));
});

afterEach(() => {
  rmSync(dataRoot, { recursive: true, force: true });
});

describe("invalidatePaperDerivedData (office supplement)", () => {
  test("deletes merged.md + the variant's extractions, keeps the transcriptions / merged.pdf / index / aggregation", async () => {
    const { paperDir, extractionsDir, aggregation, encoded } = seed();

    await invalidatePaperDerivedData(dataRoot, DOI, VARIANT);

    expect(existsSync(join(paperDir, "merged.md"))).toBe(false);
    expect(existsSync(join(extractionsDir, `${encoded}.json`))).toBe(false);
    expect(existsSync(join(extractionsDir, `${encoded}_raw.json`))).toBe(false);
    // The PDFs are unchanged, so transcription + merged.pdf + index survive;
    // aggregate overwrites its own output every run, so it is left in place.
    expect(existsSync(join(paperDir, "main.md"))).toBe(true);
    expect(existsSync(join(paperDir, "merged.pdf"))).toBe(true);
    expect(existsSync(join(paperDir, "pdf_index.pkl.zst"))).toBe(true);
    expect(existsSync(aggregation)).toBe(true);
  });

  test("without a variantId, invalidates only the paper-global merged.md", async () => {
    const { paperDir, extractionsDir, encoded } = seed();

    await invalidatePaperDerivedData(dataRoot, DOI);

    expect(existsSync(join(paperDir, "merged.md"))).toBe(false);
    expect(existsSync(join(extractionsDir, `${encoded}.json`))).toBe(true);
  });

  test("is best-effort when the derived data is already absent", async () => {
    await expect(
      invalidatePaperDerivedData(dataRoot, DOI, VARIANT),
    ).resolves.toBeUndefined();
  });
});

describe("invalidatePdfSupplementChange", () => {
  test("deletes merged.pdf + index + merged.md (+ extractions), keeps main.md and the sidecars", async () => {
    const { paperDir, extractionsDir, aggregation, encoded } = seed();

    await invalidatePdfSupplementChange(dataRoot, DOI, VARIANT);

    expect(existsSync(join(paperDir, "merged.pdf"))).toBe(false);
    expect(existsSync(join(paperDir, "pdf_index.pkl.zst"))).toBe(false);
    expect(existsSync(join(paperDir, "merged.md"))).toBe(false);
    expect(existsSync(join(extractionsDir, `${encoded}.json`))).toBe(false);
    // main.md + the other supplements' sidecars survive, so convert only
    // re-transcribes the changed supplement.
    expect(existsSync(join(paperDir, "main.md"))).toBe(true);
    expect(existsSync(join(paperDir, "supplements", "000_s.pdf.md"))).toBe(
      true,
    );
    expect(existsSync(aggregation)).toBe(true);
  });
});

describe("invalidateMainPdfChange", () => {
  test("also deletes main.md, but keeps the supplement sidecars (main-independent)", async () => {
    const { paperDir } = seed();

    await invalidateMainPdfChange(dataRoot, DOI, VARIANT);

    expect(existsSync(join(paperDir, "main.md"))).toBe(false);
    expect(existsSync(join(paperDir, "merged.pdf"))).toBe(false);
    expect(existsSync(join(paperDir, "pdf_index.pkl.zst"))).toBe(false);
    expect(existsSync(join(paperDir, "merged.md"))).toBe(false);
    expect(existsSync(join(paperDir, "supplements", "000_s.pdf.md"))).toBe(
      true,
    );
  });
});
