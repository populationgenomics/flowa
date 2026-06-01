import { describe, it, expect } from "vitest";
import {
  isCitationHref,
  parseCiteHref,
  parseCitationsFromMarkdown,
} from "./sanitize";

// --- isCitationHref ---

describe("isCitationHref", () => {
  it("accepts valid citation hrefs", () => {
    expect(isCitationHref("#cite:Cook2023")).toBe(true);
    expect(isCitationHref("#cite:Smith2022a")).toBe(true);
    expect(isCitationHref("#cite:A")).toBe(true);
  });

  it("rejects invalid hrefs", () => {
    expect(isCitationHref("https://evil.com")).toBe(false);
    expect(isCitationHref("#cite:")).toBe(false);
    expect(isCitationHref("#cite:Cook 2023")).toBe(false);
    expect(isCitationHref("#cite:Cook2023:42")).toBe(false);
    expect(isCitationHref("")).toBe(false);
  });
});

// --- parseCiteHref ---

describe("parseCiteHref", () => {
  it("parses valid citation hrefs", () => {
    expect(parseCiteHref("#cite:Cook2023")).toEqual({
      paperId: "Cook2023",
    });
    expect(parseCiteHref("#cite:Smith2022a")).toEqual({
      paperId: "Smith2022a",
    });
  });

  it("returns null for invalid hrefs", () => {
    expect(parseCiteHref("https://evil.com")).toBeNull();
    expect(parseCiteHref("#cite:")).toBeNull();
    expect(parseCiteHref("#cite:Cook2023:42")).toBeNull();
    expect(parseCiteHref("")).toBeNull();
  });
});

// --- parseCitationsFromMarkdown ---

describe("parseCitationsFromMarkdown", () => {
  it("extracts citations from markdown text", () => {
    const md =
      'According to [functional studies](#cite:Smith2024 "complete loss of enzymatic activity"), the variant is pathogenic.';
    expect(parseCitationsFromMarkdown(md)).toEqual([
      { paperId: "Smith2024", quote: "complete loss of enzymatic activity" },
    ]);
  });

  it("extracts multiple citations", () => {
    const md =
      '[Study A](#cite:Cook2023 "first quote") and [Study B](#cite:Weiss2023 "second quote") both confirm this.';
    expect(parseCitationsFromMarkdown(md)).toEqual([
      { paperId: "Cook2023", quote: "first quote" },
      { paperId: "Weiss2023", quote: "second quote" },
    ]);
  });

  it("returns empty array for text without citations", () => {
    expect(parseCitationsFromMarkdown("No citations here.")).toEqual([]);
    expect(parseCitationsFromMarkdown("")).toEqual([]);
  });

  it("ignores citations without title (quote)", () => {
    const md = "[Cook2023](#cite:Cook2023) has no quote.";
    expect(parseCitationsFromMarkdown(md)).toEqual([]);
  });

  it("ignores non-citation links", () => {
    const md = "[click](https://example.com) is not a citation.";
    expect(parseCitationsFromMarkdown(md)).toEqual([]);
  });

  it("handles multiline markdown", () => {
    const md = [
      'Line 1 with [cite A](#cite:Smith2024 "quote A").',
      "Line 2 with no cite.",
      'Line 3 with [cite B](#cite:Cook2023 "quote B").',
    ].join("\n");
    expect(parseCitationsFromMarkdown(md)).toEqual([
      { paperId: "Smith2024", quote: "quote A" },
      { paperId: "Cook2023", quote: "quote B" },
    ]);
  });
});
