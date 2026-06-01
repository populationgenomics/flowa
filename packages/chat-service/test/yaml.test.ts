import { describe, expect, test } from "vitest";
import {
  artifactToYaml,
  buildLocationCache,
  insertAtLine,
  parseArtifactYaml,
  reattachLocations,
} from "../src/yaml.js";
import type { Artifact } from "../src/artifact.js";

// ---------------------------------------------------------------------------
// insertAtLine
// ---------------------------------------------------------------------------

describe("insertAtLine", () => {
  test("line 0 prepends", () => {
    expect(insertAtLine("a\nb\nc", 0, "NEW")).toBe("NEW\na\nb\nc");
  });

  test("line equal to length appends", () => {
    expect(insertAtLine("a\nb\nc", 3, "NEW")).toBe("a\nb\nc\nNEW");
  });

  test("mid-file insert", () => {
    expect(insertAtLine("a\nb\nc", 2, "NEW")).toBe("a\nb\nNEW\nc");
  });

  test("multi-line insert text splits on newlines", () => {
    expect(insertAtLine("a\nb", 1, "X\nY")).toBe("a\nX\nY\nb");
  });

  test("line beyond length clamps to end", () => {
    expect(insertAtLine("a\nb", 99, "Z")).toBe("a\nb\nZ");
  });
});

// ---------------------------------------------------------------------------
// artifactToYaml
// ---------------------------------------------------------------------------

describe("artifactToYaml", () => {
  test("strips the citation location from claim citations", () => {
    const json = JSON.stringify({
      category: "cat-A",
      description: "summary",
      notes: "n",
      papers: [{ paper_id: "Smith2024", rank_rationale: "top" }],
      claims: [
        {
          paper_id: "Smith2024",
          text: "claim",
          citations: [
            {
              quote: "complete loss",
              location: {
                bboxes: [{ page: 1, top: 2, left: 3, bottom: 4, right: 5 }],
                markdown_anchor: { start: 10, end: 22 },
              },
            },
          ],
        },
      ],
    });
    const yamlOut = artifactToYaml(json);
    expect(yamlOut).not.toContain("location");
    expect(yamlOut).not.toContain("bboxes");
    expect(yamlOut).not.toContain("markdown_anchor");
    expect(yamlOut).toContain("complete loss");
    const parsed = parseArtifactYaml(yamlOut) as Artifact;
    expect(parsed.claims[0]?.citations[0]?.quote).toBe("complete loss");
    expect(parsed.claims[0]?.citations[0]?.location).toBeUndefined();
  });

  test("preserves top-level fields", () => {
    const json = JSON.stringify({
      category: "cat-A",
      description: "desc",
      notes: "line 1\nline 2",
      papers: [],
      claims: [],
    });
    const yamlOut = artifactToYaml(json);
    const parsed = parseArtifactYaml(yamlOut) as Record<string, unknown>;
    expect(parsed.category).toBe("cat-A");
    expect(parsed.description).toBe("desc");
    expect(parsed.notes).toBe("line 1\nline 2");
    expect(parsed.papers).toEqual([]);
    expect(parsed.claims).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// buildLocationCache + reattachLocations
// ---------------------------------------------------------------------------

describe("buildLocationCache + reattachLocations", () => {
  test("roundtrip preserves the location by (paper_id, quote)", () => {
    const location = {
      bboxes: [{ page: 7, top: 10, left: 20, bottom: 30, right: 40 }],
      markdown_anchor: { start: 5, end: 17 },
    };
    const original: Artifact = {
      category: "cat-A",
      description: "d",
      notes: "n",
      papers: [
        { paper_id: "Smith2024", rank_rationale: "top" },
        { paper_id: "Jones2023", rank_rationale: "next" },
      ],
      claims: [
        {
          paper_id: "Smith2024",
          text: "c1",
          citations: [{ quote: "q1", location }],
        },
        {
          paper_id: "Jones2023",
          text: "c2",
          citations: [{ quote: "q2" }],
        },
      ],
    };
    const cache = buildLocationCache(JSON.stringify(original));
    const stripped: Artifact = {
      ...original,
      claims: original.claims.map((claim) => ({
        ...claim,
        citations: claim.citations.map(
          ({ location: _location, ...rest }) => rest,
        ),
      })),
    };
    const reattached = reattachLocations(stripped, cache);
    expect(reattached.claims[0]?.citations[0]?.location).toEqual(location);
    expect(reattached.claims[1]?.citations[0]?.location).toBeUndefined();
  });

  test("citation with unknown (paper_id, quote) keeps no location", () => {
    const cache = buildLocationCache(
      JSON.stringify({
        category: "cat-A",
        description: "d",
        notes: "n",
        papers: [{ paper_id: "Smith2024", rank_rationale: "top" }],
        claims: [
          {
            paper_id: "Smith2024",
            text: "c1",
            citations: [
              {
                quote: "q1",
                location: {
                  bboxes: [{ page: 1, top: 1, left: 1, bottom: 1, right: 1 }],
                  markdown_anchor: null,
                },
              },
            ],
          },
        ],
      }),
    );
    const artifact: Artifact = {
      category: "cat-A",
      description: "d",
      notes: "n",
      papers: [{ paper_id: "Smith2024", rank_rationale: "top" }],
      claims: [
        {
          paper_id: "Smith2024",
          text: "c1",
          citations: [{ quote: "different quote" }],
        },
      ],
    };
    const out = reattachLocations(artifact, cache);
    expect(out.claims[0]?.citations[0]?.location).toBeUndefined();
  });
});
