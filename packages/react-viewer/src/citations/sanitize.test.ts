// @vitest-environment happy-dom

import { describe, it, expect } from "vitest";
import {
  isCitationHref,
  parseCiteHref,
  parseCitationsFromMarkdown,
  stripInvalidLinks,
  sanitizeLlmMarkdown,
} from "./sanitize";
import type { PaperIdMapping } from "./types";

// --- Shared test fixtures ---

const PAPER_ID_MAPPING: PaperIdMapping = {
  byAuthorYear: {
    Cook2023: { doi: "10.1002/humu.23595" },
    Weiss2023: { doi: "10.2169/internalmedicine.9843-17", pmid: 29434162 },
  },
  byDoi: {
    "10.1002/humu.23595": "Cook2023",
    "10.2169/internalmedicine.9843-17": "Weiss2023",
  },
};

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

// --- stripInvalidLinks ---

describe("stripInvalidLinks", () => {
  it("preserves valid citation links", () => {
    const html = '<a href="#cite:Cook2023">Cook2023</a>';
    const result = stripInvalidLinks(html, PAPER_ID_MAPPING);
    expect(result).toContain('href="#cite:Cook2023"');
    expect(result).toContain("Cook2023");
  });

  it("preserves title attribute on valid links", () => {
    const html =
      '<a href="#cite:Cook2023" title="complete loss of activity">Cook2023</a>';
    const result = stripInvalidLinks(html, PAPER_ID_MAPPING);
    expect(result).toContain('title="complete loss of activity"');
    expect(result).toContain('href="#cite:Cook2023"');
  });

  it("strips external links, keeps text", () => {
    const html = '<a href="https://evil.com">Click me</a>';
    const result = stripInvalidLinks(html, PAPER_ID_MAPPING);
    expect(result).not.toContain("<a");
    expect(result).toContain("Click me");
  });

  it("strips syntactically invalid citation links", () => {
    const html = '<a href="#cite:invalid:42">text</a>';
    const result = stripInvalidLinks(html, PAPER_ID_MAPPING);
    expect(result).not.toContain("<a");
    expect(result).toContain("text");
  });

  it("strips links with unknown AuthorYear", () => {
    const html = '<a href="#cite:BogusKey">BogusKey</a>';
    const result = stripInvalidLinks(html, PAPER_ID_MAPPING);
    expect(result).not.toContain("<a");
    expect(result).toContain("BogusKey");
  });

  it("preserves valid links among mixed valid/invalid", () => {
    const html =
      '<a href="#cite:Cook2023">valid</a> and <a href="https://evil.com">bad</a> and <a href="#cite:BogusKey">bogus</a>';
    const result = stripInvalidLinks(html, PAPER_ID_MAPPING);
    expect(result).toContain('href="#cite:Cook2023"');
    expect(result).toContain("valid");
    expect(result).not.toContain("evil.com");
    expect(result).toContain("bad");
    expect(result).toContain("bogus");
    // Only the valid link should remain as <a>
    expect(result.match(/<a /g)?.length).toBe(1);
  });
});

// --- sanitizeLlmMarkdown ---

describe("sanitizeLlmMarkdown", () => {
  it("converts Markdown with valid citation links to HTML", () => {
    const md =
      '- [**Cook2023**](#cite:Cook2023 "complete loss of activity"): found 3 cases.';
    const result = sanitizeLlmMarkdown(md, PAPER_ID_MAPPING);
    expect(result).toContain('href="#cite:Cook2023"');
    expect(result).toContain("found 3 cases");
  });

  it("preserves title attribute through the pipeline", () => {
    const md =
      '[Functional studies](#cite:Cook2023 "complete loss of enzymatic activity") confirm this.';
    const result = sanitizeLlmMarkdown(md, PAPER_ID_MAPPING);
    expect(result).toContain('title="complete loss of enzymatic activity"');
    expect(result).toContain('href="#cite:Cook2023"');
    expect(result).toContain("Functional studies");
  });

  it("strips external links from Markdown, preserves text", () => {
    const md = "[Click me](https://evil.com) is bad.";
    const result = sanitizeLlmMarkdown(md, PAPER_ID_MAPPING);
    expect(result).not.toContain("evil.com");
    expect(result).not.toContain("<a");
    expect(result).toContain("Click me");
    expect(result).toContain("is bad");
  });

  it("strips <script> tags", () => {
    const md = "Safe text <script>alert('xss')</script> more text";
    const result = sanitizeLlmMarkdown(md, PAPER_ID_MAPPING);
    expect(result).not.toContain("<script");
    expect(result).toContain("Safe text");
    expect(result).toContain("more text");
  });

  it("handles Markdown with no links", () => {
    const md = "**Bold** and _italic_ text.";
    const result = sanitizeLlmMarkdown(md, PAPER_ID_MAPPING);
    expect(result).toContain("<strong>Bold</strong>");
    expect(result).toContain("<em>italic</em>");
  });

  it("handles empty string", () => {
    const result = sanitizeLlmMarkdown("", PAPER_ID_MAPPING);
    expect(result).toBe("");
  });

  it("strips hallucinated citation (AuthorYear not in mapping)", () => {
    const md = '[BogusKey](#cite:BogusKey "some quote") claims something.';
    const result = sanitizeLlmMarkdown(md, PAPER_ID_MAPPING);
    expect(result).not.toContain("<a");
    expect(result).toContain("BogusKey");
    expect(result).toContain("claims something");
  });
});
