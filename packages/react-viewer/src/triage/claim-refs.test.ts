import { describe, it, expect } from "vitest";
import {
  groupClaimsByPaper,
  resolveClaimForCitation,
  indexClaimsByPaperIdAndText,
} from "./claim-refs";
import type { Claim } from "./types";

const CLAIMS: Claim[] = [
  {
    paperId: "Smith2024",
    text: "F508del causes CFTR misfolding.",
    citations: [{ quote: "F508del leads to misfolded CFTR" }],
  },
  {
    paperId: "Smith2024",
    text: "Misfolded CFTR is degraded by ERAD.",
    citations: [
      { quote: "ER-associated degradation removes misfolded F508del" },
    ],
  },
  {
    paperId: "Jones2023",
    text: "Pancreatic insufficiency in 92% of homozygotes.",
    citations: [
      {
        quote:
          "homozygous F508del patients exhibit pancreatic insufficiency in approximately 92% of cases",
      },
    ],
  },
];

describe("groupClaimsByPaper", () => {
  it("groups claims by paperId, preserving insertion order", () => {
    const groups = groupClaimsByPaper(CLAIMS);
    expect([...groups.keys()]).toEqual(["Smith2024", "Jones2023"]);
    expect(groups.get("Smith2024")).toHaveLength(2);
    expect(groups.get("Jones2023")).toHaveLength(1);
  });

  it("returns an empty map for an empty claim list", () => {
    expect(groupClaimsByPaper([]).size).toBe(0);
  });
});

describe("resolveClaimForCitation", () => {
  it("returns null when the paperId is unknown", () => {
    expect(
      resolveClaimForCitation("Unknown1999", "anything", CLAIMS),
    ).toBeNull();
  });

  it("matches an exact citation quote and returns 1-based claim index", () => {
    expect(
      resolveClaimForCitation(
        "Smith2024",
        "F508del leads to misfolded CFTR",
        CLAIMS,
      ),
    ).toEqual({ paperId: "Smith2024", claimIndex: 1 });

    expect(
      resolveClaimForCitation(
        "Smith2024",
        "ER-associated degradation removes misfolded F508del",
        CLAIMS,
      ),
    ).toEqual({ paperId: "Smith2024", claimIndex: 2 });
  });

  it("trims whitespace before equality matching", () => {
    expect(
      resolveClaimForCitation(
        "Smith2024",
        "  F508del leads to misfolded CFTR  ",
        CLAIMS,
      ),
    ).toEqual({ paperId: "Smith2024", claimIndex: 1 });
  });

  it("falls back to longest-common-prefix match when no exact quote matches", () => {
    // Probe shares 60+ characters with Jones2023's stored quote then drifts.
    expect(
      resolveClaimForCitation(
        "Jones2023",
        "homozygous F508del patients exhibit pancreatic insufficiency in the majority of European cohorts",
        CLAIMS,
      ),
    ).toEqual({ paperId: "Jones2023", claimIndex: 1 });
  });

  it("rejects a fuzzy match shorter than the 40-character threshold", () => {
    // Shares only 17 characters with the stored quote.
    expect(
      resolveClaimForCitation(
        "Jones2023",
        "homozygous F508d but mild phenotype overall",
        CLAIMS,
      ),
    ).toBeNull();
  });

  it("restarts the per-paper index when paperId changes mid-list", () => {
    expect(
      resolveClaimForCitation(
        "Jones2023",
        "homozygous F508del patients exhibit pancreatic insufficiency in approximately 92% of cases",
        CLAIMS,
      ),
    ).toEqual({ paperId: "Jones2023", claimIndex: 1 });
  });
});

describe("indexClaimsByPaperIdAndText", () => {
  it("indexes by (paperId, text) and assigns 1-based per-paper claim indices", () => {
    const idx = indexClaimsByPaperIdAndText(CLAIMS);
    expect(idx.get("Smith2024\nF508del causes CFTR misfolding.")).toEqual({
      paperId: "Smith2024",
      claimIndex: 1,
    });
    expect(idx.get("Smith2024\nMisfolded CFTR is degraded by ERAD.")).toEqual({
      paperId: "Smith2024",
      claimIndex: 2,
    });
    expect(
      idx.get("Jones2023\nPancreatic insufficiency in 92% of homozygotes."),
    ).toEqual({ paperId: "Jones2023", claimIndex: 1 });
  });
});
