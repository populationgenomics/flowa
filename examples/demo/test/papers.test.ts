/**
 * Tests for the per-variant papers listing helper. Builds a tmp
 * `demo-data/` tree (query.json + per-paper files at the canonical
 * filesystem layout) and asserts each status-derivation branch.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeDoi } from "@flowajs/react-viewer";
import { listPapersForVariant } from "../src/lib/papers";

let dataRoot: string;

beforeEach(() => {
  dataRoot = mkdtempSync(join(tmpdir(), "flowa-demo-papers-"));
});

afterEach(() => {
  rmSync(dataRoot, { recursive: true, force: true });
});

function writeQuery(variantId: string, dois: string[]): void {
  const dir = join(dataRoot, "assessments", variantId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "query.json"),
    JSON.stringify({
      schema_version: 1,
      gene: "RYR2",
      hgvs_c: "NM_001035.3:c.14174A>G",
      dois,
    }),
  );
}

function writeAggregate(variantId: string, categories: string[]): void {
  const dir = join(dataRoot, "assessments", variantId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "aggregate.json"),
    JSON.stringify({
      schema_version: 1,
      results: categories.map((c) => ({ category: c })),
    }),
  );
}

function writePaperPdf(doi: string): void {
  const encoded = encodeDoi(doi);
  const dir = join(dataRoot, "papers", encoded);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "source.pdf"), "%PDF-1.7 stub");
}

function writePaperMetadata(
  doi: string,
  meta: { title: string; authors: string; pmid?: number },
): void {
  const encoded = encodeDoi(doi);
  const dir = join(dataRoot, "papers", encoded);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "metadata.json"), JSON.stringify({ doi, ...meta }));
}

function writeExtraction(variantId: string, doi: string): void {
  const encoded = encodeDoi(doi);
  const dir = join(dataRoot, "assessments", variantId, "extractions");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${encoded}.json`), JSON.stringify({ stub: true }));
}

describe("listPapersForVariant", () => {
  test("returns empty when query.json is absent (pre-query state)", async () => {
    const result = await listPapersForVariant("never-ran", {
      dataDir: dataRoot,
    });
    expect(result).toEqual({
      papers: [],
      aggregateExists: false,
      categories: [],
    });
  });

  test("status is `needs_manual` when neither PDF nor extract exist", async () => {
    writeQuery("V1", ["10.1234/foo"]);
    const result = await listPapersForVariant("V1", { dataDir: dataRoot });
    expect(result.papers[0]?.status).toBe("needs_manual");
  });

  test("status is `downloaded` when PDF exists but extract doesn't", async () => {
    writeQuery("V1", ["10.1234/foo"]);
    writePaperPdf("10.1234/foo");
    const result = await listPapersForVariant("V1", { dataDir: dataRoot });
    expect(result.papers[0]?.status).toBe("downloaded");
  });

  test("status is `extracted` when extract exists (even without PDF on disk)", async () => {
    writeQuery("V1", ["10.1234/foo"]);
    writeExtraction("V1", "10.1234/foo");
    const result = await listPapersForVariant("V1", { dataDir: dataRoot });
    expect(result.papers[0]?.status).toBe("extracted");
  });

  test("merges metadata.json fields into the row when present", async () => {
    writeQuery("V1", ["10.1234/foo"]);
    writePaperPdf("10.1234/foo");
    writePaperMetadata("10.1234/foo", {
      title: "A paper",
      authors: "Author One; Author Two",
      pmid: 99999,
    });
    const result = await listPapersForVariant("V1", { dataDir: dataRoot });
    expect(result.papers[0]).toMatchObject({
      doi: "10.1234/foo",
      title: "A paper",
      authors: "Author One; Author Two",
      pmid: 99999,
      url: "https://doi.org/10.1234/foo",
    });
  });

  test("leaves title/authors/pmid null when metadata.json is absent", async () => {
    writeQuery("V1", ["10.1234/foo"]);
    const result = await listPapersForVariant("V1", { dataDir: dataRoot });
    expect(result.papers[0]).toMatchObject({
      title: null,
      authors: null,
      pmid: null,
    });
  });

  test("returns aggregateExists + categories when aggregate.json is present", async () => {
    writeQuery("V1", ["10.1234/foo"]);
    writeAggregate("V1", ["acmg_classification"]);
    const result = await listPapersForVariant("V1", { dataDir: dataRoot });
    expect(result.aggregateExists).toBe(true);
    expect(result.categories).toEqual(["acmg_classification"]);
  });

  test("supports multi-category aggregates", async () => {
    writeQuery("V1", ["10.1234/foo"]);
    writeAggregate("V1", ["acmg_classification", "phenotype_summary"]);
    const result = await listPapersForVariant("V1", { dataDir: dataRoot });
    expect(result.categories).toEqual([
      "acmg_classification",
      "phenotype_summary",
    ]);
  });

  test("preserves DOI ordering from query.json", async () => {
    writeQuery("V1", ["10.1234/c", "10.1234/a", "10.1234/b"]);
    const result = await listPapersForVariant("V1", { dataDir: dataRoot });
    expect(result.papers.map((p) => p.doi)).toEqual([
      "10.1234/c",
      "10.1234/a",
      "10.1234/b",
    ]);
  });
});
