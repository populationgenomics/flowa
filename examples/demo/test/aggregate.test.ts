import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadAggregate,
  loadEditDraft,
  listVersions,
} from "../src/lib/aggregate";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "flowa-demo-aggregate-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function writeAggregate(variantId: string, body: object): string {
  const dir = join(dataDir, "assessments", variantId);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "aggregation.json");
  writeFileSync(path, JSON.stringify(body));
  return path;
}

function writeDraft(
  variantId: string,
  category: string,
  version: number,
  body: object,
): string {
  const dir = join(dataDir, "edit-drafts", variantId, category);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `artifact-v${version}.json`);
  writeFileSync(path, JSON.stringify(body));
  return path;
}

const SAMPLE_AGGREGATE = {
  schema_version: 1,
  paper_id_mapping: {
    Smith2024: { doi: "10.1234/smith.2024", pmid: 11111 },
    Jones2023: { doi: "10.1234/jones.2023" },
  },
  results: [
    {
      category: "acmg_classification",
      classification: "Pathogenic",
      classification_rationale: "Strong evidence.",
      description: "Description text.",
      notes: "Notes text.",
      papers: [
        { paper_id: "Smith2024", rank_rationale: "Functional." },
        { paper_id: "Jones2023", rank_rationale: "Clinical." },
      ],
      claims: [
        {
          paper_id: "Smith2024",
          text: "Claim 1",
          citations: [{ quote: "quote 1" }],
        },
        {
          paper_id: "Jones2023",
          text: "Claim 2",
          citations: [{ quote: "quote 2" }],
        },
      ],
    },
  ],
};

describe("loadAggregate", () => {
  test("parses snake_case JSON into camelCase CategorySuggestion", async () => {
    writeAggregate("v1", SAMPLE_AGGREGATE);
    const loaded = await loadAggregate("v1", "acmg_classification", {
      dataDir,
    });
    expect(loaded).not.toBeNull();
    expect(loaded!.artifact.code).toBe("Pathogenic");
    expect(loaded!.artifact.codeRationale).toBe("Strong evidence.");
    expect(loaded!.artifact.descriptionShort).toBe("Description text.");
    expect(loaded!.artifact.papers).toEqual([
      { paperId: "Smith2024", rankRationale: "Functional." },
      { paperId: "Jones2023", rankRationale: "Clinical." },
    ]);
    expect(loaded!.artifact.claims[0]?.paperId).toBe("Smith2024");
    expect(loaded!.artifact.claims[0]?.citations[0]?.quote).toBe("quote 1");
  });

  test("artifactText is the per-category snake_case JSON, not the full wrapper", async () => {
    writeAggregate("v1", SAMPLE_AGGREGATE);
    const loaded = await loadAggregate("v1", "acmg_classification", {
      dataDir,
    });
    const parsed = JSON.parse(loaded!.artifactText) as Record<string, unknown>;
    // chat-service iterates `claims` and `papers` directly; the wrapper
    // shape (`results[]` / `paper_id_mapping`) would crash it with
    // "artifact.claims is not iterable".
    expect(parsed.results).toBeUndefined();
    expect(parsed.paper_id_mapping).toBeUndefined();
    expect(parsed.category).toBe("acmg_classification");
    expect(Array.isArray(parsed.claims)).toBe(true);
    expect(Array.isArray(parsed.papers)).toBe(true);
  });

  test("derives byDoi from the on-disk paper_id_mapping", async () => {
    writeAggregate("v1", SAMPLE_AGGREGATE);
    const loaded = await loadAggregate("v1", "acmg_classification", {
      dataDir,
    });
    expect(loaded!.paperIdMapping.byAuthorYear).toEqual({
      Smith2024: { doi: "10.1234/smith.2024", pmid: 11111 },
      Jones2023: { doi: "10.1234/jones.2023" },
    });
    expect(loaded!.paperIdMapping.byDoi).toEqual({
      "10.1234/smith.2024": "Smith2024",
      "10.1234/jones.2023": "Jones2023",
    });
  });

  test("returns null when the variant is missing", async () => {
    const loaded = await loadAggregate("missing", "acmg_classification", {
      dataDir,
    });
    expect(loaded).toBeNull();
  });

  test("returns null when the category isn't in the aggregate", async () => {
    writeAggregate("v1", SAMPLE_AGGREGATE);
    const loaded = await loadAggregate("v1", "other_category", { dataDir });
    expect(loaded).toBeNull();
  });

  test("derives paperIdMapping from per-paper metadata when on-disk mapping is missing", async () => {
    const stripped = {
      ...SAMPLE_AGGREGATE,
      paper_id_mapping: undefined,
    };
    writeAggregate("v1", stripped);
    // Seed a metadata.json for Smith2024.
    const dir = join(dataDir, "papers", "10.1234%2Fsmith.2024");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "metadata.json"),
      JSON.stringify({
        doi: "10.1234/smith.2024",
        pmid: 11111,
        authors: "Smith, Jane; Doe, John",
        date: "2024-06-01",
        title: "...",
      }),
    );
    const loaded = await loadAggregate("v1", "acmg_classification", {
      dataDir,
    });
    expect(loaded!.paperIdMapping.byAuthorYear).toEqual({
      Smith2024: { doi: "10.1234/smith.2024", pmid: 11111 },
    });
    expect(loaded!.paperIdMapping.byDoi).toEqual({
      "10.1234/smith.2024": "Smith2024",
    });
  });
});

describe("listVersions", () => {
  test("returns empty when nothing exists", async () => {
    const out = await listVersions("v1", "acmg_classification", { dataDir });
    expect(out).toEqual([]);
  });

  test("returns just v0 when only aggregation.json exists", async () => {
    writeAggregate("v1", SAMPLE_AGGREGATE);
    const out = await listVersions("v1", "acmg_classification", { dataDir });
    expect(out.map((v) => v.version)).toEqual([0]);
  });

  test("returns v0..vN in order when drafts exist", async () => {
    writeAggregate("v1", SAMPLE_AGGREGATE);
    writeDraft("v1", "acmg_classification", 1, {
      category: "acmg_classification",
      classification: "Pathogenic",
      classification_rationale: "edit 1",
      description: "Description text v1.",
      notes: "Notes text v1.",
      papers: [],
      claims: [],
    });
    writeDraft("v1", "acmg_classification", 2, {
      category: "acmg_classification",
      classification: "Pathogenic",
      classification_rationale: "edit 2",
      description: "Description text v2.",
      notes: "Notes text v2.",
      papers: [],
      claims: [],
    });
    const out = await listVersions("v1", "acmg_classification", { dataDir });
    expect(out.map((v) => v.version)).toEqual([0, 1, 2]);
  });
});

describe("loadEditDraft", () => {
  test("reads a draft and reuses paperIdMapping from the pipeline aggregate", async () => {
    writeAggregate("v1", SAMPLE_AGGREGATE);
    writeDraft("v1", "acmg_classification", 1, {
      category: "acmg_classification",
      classification: "Likely Pathogenic",
      classification_rationale: "After triage edits.",
      description: "Updated description.",
      notes: "Updated notes.",
      papers: [{ paper_id: "Smith2024", rank_rationale: "Still functional." }],
      claims: [
        {
          paper_id: "Smith2024",
          text: "Edited claim",
          citations: [{ quote: "edited quote" }],
        },
      ],
    });
    const loaded = await loadEditDraft("v1", "acmg_classification", 1, {
      dataDir,
    });
    expect(loaded).not.toBeNull();
    expect(loaded!.artifact.code).toBe("Likely Pathogenic");
    expect(loaded!.artifact.descriptionShort).toBe("Updated description.");
    expect(loaded!.paperIdMapping.byDoi["10.1234/smith.2024"]).toBe(
      "Smith2024",
    );
  });

  test("returns null for v0", async () => {
    writeAggregate("v1", SAMPLE_AGGREGATE);
    expect(
      await loadEditDraft("v1", "acmg_classification", 0, { dataDir }),
    ).toBeNull();
  });

  test("returns null when the requested version doesn't exist", async () => {
    writeAggregate("v1", SAMPLE_AGGREGATE);
    expect(
      await loadEditDraft("v1", "acmg_classification", 99, { dataDir }),
    ).toBeNull();
  });
});
