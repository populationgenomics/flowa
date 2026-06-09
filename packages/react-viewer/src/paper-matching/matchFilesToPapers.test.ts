import { describe, it, expect } from "vitest";
import {
  matchFilesToPapers,
  parseSupplementFilename,
  type MatchablePaper,
} from "./matchFilesToPapers";

const PAPERS: MatchablePaper[] = [
  { doi: "10.1371/journal.pone.0001", pmid: 12345 },
  { doi: "10.1234/jones.2023", pmid: 67890 },
  { doi: "10.5555/no.pmid" }, // DOI-only (no PMID)
];

// encodeDoi("10.5555/no.pmid") === "10.5555%2Fno.pmid"
const NO_PMID_ENCODED = "10.5555%2Fno.pmid";

describe("parseSupplementFilename", () => {
  it("returns the id for supplement-shaped names", () => {
    expect(parseSupplementFilename("12345_supp.xlsx")).toBe("12345");
    expect(parseSupplementFilename("12345 supp.pdf")).toBe("12345");
    expect(parseSupplementFilename("12345_supplementary_data.docx")).toBe(
      "12345",
    );
    expect(parseSupplementFilename("12345_SUPP.xlsx")).toBe("12345");
  });

  it("returns null for non-supplement names", () => {
    expect(parseSupplementFilename("12345.pdf")).toBeNull();
    expect(parseSupplementFilename("support.pdf")).toBeNull();
  });

  it("matches the documented benign false positive", () => {
    // `_supp` inside `_support` matches the rule as specified.
    expect(parseSupplementFilename("gene_support.pdf")).toBe("gene");
  });
});

describe("matchFilesToPapers — mains", () => {
  it("matches by PMID, with or without a PMID prefix", () => {
    const result = matchFilesToPapers(["12345.pdf", "PMID_67890.pdf"], PAPERS);
    expect(result.mains).toEqual([
      { filename: "12345.pdf", paper: PAPERS[0] },
      { filename: "PMID_67890.pdf", paper: PAPERS[1] },
    ]);
    expect(result.unmatched).toEqual([]);
  });

  it("matches by encoded DOI", () => {
    const result = matchFilesToPapers([`${NO_PMID_ENCODED}.pdf`], PAPERS);
    expect(result.mains).toEqual([
      { filename: `${NO_PMID_ENCODED}.pdf`, paper: PAPERS[2] },
    ]);
  });

  it("leaves an unrecognised main unmatched", () => {
    const result = matchFilesToPapers(["99999.pdf", "notes.txt"], PAPERS);
    expect(result.mains).toEqual([]);
    expect(result.unmatched).toEqual(["99999.pdf", "notes.txt"]);
  });

  it("matches a paper at most once (first file wins)", () => {
    const result = matchFilesToPapers(["12345.pdf", "PMID12345.pdf"], PAPERS);
    expect(result.mains).toEqual([{ filename: "12345.pdf", paper: PAPERS[0] }]);
    expect(result.unmatched).toEqual(["PMID12345.pdf"]);
  });

  it("requires a .pdf suffix for a main (a bare id or other extension is not a paper)", () => {
    const result = matchFilesToPapers(["12345", "12345.txt"], PAPERS);
    expect(result.mains).toEqual([]);
    expect(result.unmatched).toEqual(["12345", "12345.txt"]);
  });

  it("ignores a PMID-less paper when the id is numeric", () => {
    // PAPERS[2] has no pmid; "67890" only matches PAPERS[1] via its pmid.
    const onlyNoPmid = [PAPERS[2]!];
    expect(matchFilesToPapers(["67890.pdf"], onlyNoPmid).mains).toEqual([]);
  });

  it("prefers a PMID over an encoded-DOI that collides on the same digits", () => {
    const papers: MatchablePaper[] = [
      { doi: "10.1/x", pmid: 26114861 },
      { doi: "26114861", pmid: null }, // encodeDoi("26114861") === "26114861"
    ];
    expect(matchFilesToPapers(["26114861.pdf"], papers).mains).toEqual([
      { filename: "26114861.pdf", paper: papers[0] },
    ]);
  });
});

describe("matchFilesToPapers — supplements", () => {
  it("attaches a supplement via its PMID id", () => {
    const result = matchFilesToPapers(["12345_supp.xlsx"], PAPERS);
    expect(result.supplements).toEqual([
      { filename: "12345_supp.xlsx", paper: PAPERS[0] },
    ]);
    expect(result.mains).toEqual([]);
  });

  it("attaches a supplement via its encoded-DOI id", () => {
    const result = matchFilesToPapers([`${NO_PMID_ENCODED}_supp.docx`], PAPERS);
    expect(result.supplements).toEqual([
      { filename: `${NO_PMID_ENCODED}_supp.docx`, paper: PAPERS[2] },
    ]);
  });

  it("resolves a supplement even with no sibling main in the set", () => {
    // Only the supplement is uploaded; 12345.pdf is absent but the paper is known.
    const result = matchFilesToPapers(["12345 supplementary.pdf"], PAPERS);
    expect(result.supplements).toEqual([
      { filename: "12345 supplementary.pdf", paper: PAPERS[0] },
    ]);
    expect(result.unmatched).toEqual([]);
  });

  it("never treats a supplement-shaped PDF as a main", () => {
    const result = matchFilesToPapers(["12345.pdf", "12345_supp.pdf"], PAPERS);
    expect(result.mains).toEqual([{ filename: "12345.pdf", paper: PAPERS[0] }]);
    expect(result.supplements).toEqual([
      { filename: "12345_supp.pdf", paper: PAPERS[0] },
    ]);
  });

  it("sorts supplements lexicographically", () => {
    const result = matchFilesToPapers(
      ["12345_supp_b.xlsx", "12345_supp_a.xlsx", "12345_supp_10.xlsx"],
      PAPERS,
    );
    expect(result.supplements.map((s) => s.filename)).toEqual([
      "12345_supp_10.xlsx", // lexicographic: "_1" < "_a", "_b"
      "12345_supp_a.xlsx",
      "12345_supp_b.xlsx",
    ]);
  });

  it("leaves an unresolved supplement unmatched", () => {
    const result = matchFilesToPapers(["99999_supp.xlsx"], PAPERS);
    expect(result.supplements).toEqual([]);
    expect(result.unmatched).toEqual(["99999_supp.xlsx"]);
  });
});
