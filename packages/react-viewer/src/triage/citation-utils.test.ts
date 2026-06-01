import { describe, it, expect } from "vitest";
import {
  encodeDoi,
  flattenClaimCitations,
  formatPaperLabel,
} from "./citation-utils";
import type { CategorySuggestion } from "./types";
import type { PaperIdMapping } from "../citations/types";

const MAPPING: PaperIdMapping = {
  byAuthorYear: {
    Smith2024: { doi: "10.1371/journal.pone.0001", pmid: 12345 },
    Jones2023: { doi: "10.1234/jones.2023" },
  },
  byDoi: {
    "10.1371/journal.pone.0001": "Smith2024",
    "10.1234/jones.2023": "Jones2023",
  },
};

const SUGGESTION: CategorySuggestion = {
  category: "acmg_classification",
  description: "Description.",
  notes: "Notes.",
  papers: [
    { paperId: "Smith2024", rankRationale: "Functional." },
    { paperId: "Jones2023", rankRationale: "Clinical." },
  ],
  claims: [
    {
      paperId: "Smith2024",
      text: "Claim 1",
      citations: [
        {
          quote: "first quote",
          location: {
            bboxes: [{ page: 1, top: 0, left: 0, bottom: 100, right: 100 }],
            markdownAnchor: null,
          },
        },
        { quote: "second quote" },
      ],
    },
    {
      paperId: "Smith2024",
      text: "Claim 2",
      citations: [{ quote: "third quote" }],
    },
    {
      paperId: "Jones2023",
      text: "Clinical claim",
      citations: [{ quote: "clinical quote" }],
    },
  ],
};

describe("flattenClaimCitations", () => {
  it("flattens claim citations and attaches the owning paper's DOI", () => {
    const flat = flattenClaimCitations(SUGGESTION, MAPPING);
    expect(flat).toHaveLength(4);
    expect(flat[0]).toMatchObject({
      doi: "10.1371/journal.pone.0001",
      paperId: "Smith2024",
      quote: "first quote",
      claimIndex: 1,
      claimText: "Claim 1",
    });
    expect(flat[0]?.location?.bboxes).toHaveLength(1);
    expect(flat[1]).toMatchObject({
      paperId: "Smith2024",
      claimIndex: 1,
      quote: "second quote",
    });
    expect(flat[2]).toMatchObject({
      paperId: "Smith2024",
      claimIndex: 2,
      quote: "third quote",
    });
    expect(flat[3]).toMatchObject({
      paperId: "Jones2023",
      claimIndex: 1,
      quote: "clinical quote",
    });
  });

  it("skips claims whose paperId is not in the mapping", () => {
    const flat = flattenClaimCitations(SUGGESTION, {
      byAuthorYear: { Smith2024: { doi: "10.1371/journal.pone.0001" } },
      byDoi: { "10.1371/journal.pone.0001": "Smith2024" },
    });
    expect(flat.every((c) => c.paperId === "Smith2024")).toBe(true);
    expect(flat).toHaveLength(3);
  });

  it("carries an undefined location for a citation with no resolution", () => {
    const flat = flattenClaimCitations(SUGGESTION, MAPPING);
    expect(flat[1]?.location).toBeUndefined();
  });

  it("returns an empty array when the mapping is undefined", () => {
    expect(flattenClaimCitations(SUGGESTION, undefined)).toEqual([]);
  });
});

describe("formatPaperLabel", () => {
  it("renders Author2024 (PMID nnn) when both AuthorYear and PMID are known", () => {
    expect(formatPaperLabel("10.1371/journal.pone.0001", 12345, MAPPING)).toBe(
      "Smith2024 (PMID 12345)",
    );
  });

  it("falls back to the DOI when PMID is missing", () => {
    expect(formatPaperLabel("10.1234/jones.2023", undefined, MAPPING)).toBe(
      "Jones2023 (10.1234/jones.2023)",
    );
  });

  it("returns just the PMID / DOI when no AuthorYear is known", () => {
    expect(formatPaperLabel("10.9999/unknown", 999, MAPPING)).toBe("PMID 999");
    expect(formatPaperLabel("10.9999/unknown", undefined, MAPPING)).toBe(
      "10.9999/unknown",
    );
  });
});

describe("encodeDoi", () => {
  it("matches Python's urllib.parse.quote(doi, safe='') for typical DOIs", () => {
    expect(encodeDoi("10.1371/journal.pone.0001")).toBe(
      "10.1371%2Fjournal.pone.0001",
    );
  });

  it("encodes the !'()* characters that encodeURIComponent leaves alone", () => {
    expect(encodeDoi("a!b'c(d)e*f")).toBe("a%21b%27c%28d%29e%2Af");
  });

  it("decodes round-trip via decodeURIComponent", () => {
    const original = "10.1234/some(weird)*doi!'name";
    expect(decodeURIComponent(encodeDoi(original))).toBe(original);
  });
});
