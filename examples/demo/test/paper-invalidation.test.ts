/**
 * Tests for `invalidatePaperDerivedData`.
 *
 * Locks the keep/delete contract a supplement change relies on: markdown.md
 * and the assessment's extractions are stale and must go; source.md,
 * pdf_index.pkl.zst (the PDF didn't change) and aggregation.json (aggregate
 * overwrites it every run) must survive.
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
import { invalidatePaperDerivedData } from "../src/lib/paperInvalidation";

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
  mkdirSync(paperDir, { recursive: true });
  mkdirSync(extractionsDir, { recursive: true });
  writeFileSync(join(paperDir, "source.md"), "transcription");
  writeFileSync(join(paperDir, "markdown.md"), "transcription + supplement");
  writeFileSync(join(paperDir, "pdf_index.pkl.zst"), "binary-index");
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

describe("invalidatePaperDerivedData", () => {
  test("deletes markdown.md + the variant's extractions, keeps PDF-derived inputs + aggregation", async () => {
    const { paperDir, extractionsDir, aggregation, encoded } = seed();

    await invalidatePaperDerivedData(dataRoot, DOI, VARIANT);

    expect(existsSync(join(paperDir, "markdown.md"))).toBe(false);
    expect(existsSync(join(extractionsDir, `${encoded}.json`))).toBe(false);
    expect(existsSync(join(extractionsDir, `${encoded}_raw.json`))).toBe(false);
    // The PDF is unchanged, so its transcription + index survive; aggregate
    // overwrites its own output on every run, so it is left in place.
    expect(existsSync(join(paperDir, "source.md"))).toBe(true);
    expect(existsSync(join(paperDir, "pdf_index.pkl.zst"))).toBe(true);
    expect(existsSync(aggregation)).toBe(true);
  });

  test("without a variantId, invalidates only the paper-global markdown.md", async () => {
    const { paperDir, extractionsDir, encoded } = seed();

    await invalidatePaperDerivedData(dataRoot, DOI);

    expect(existsSync(join(paperDir, "markdown.md"))).toBe(false);
    expect(existsSync(join(extractionsDir, `${encoded}.json`))).toBe(true);
  });

  test("is best-effort when the derived data is already absent", async () => {
    await expect(
      invalidatePaperDerivedData(dataRoot, DOI, VARIANT),
    ).resolves.toBeUndefined();
  });
});
