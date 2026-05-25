import { describe, expect, test } from "vitest";
import {
  artifactToYaml,
  buildBboxCache,
  insertAtLine,
  parseArtifactYaml,
  reattachBboxes,
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
  test("strips bboxes from claim citations", () => {
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
              bboxes: [{ page: 1, top: 2, left: 3, bottom: 4, right: 5 }],
            },
          ],
        },
      ],
    });
    const yamlOut = artifactToYaml(json);
    expect(yamlOut).not.toContain("bboxes");
    expect(yamlOut).toContain("complete loss");
    const parsed = parseArtifactYaml(yamlOut) as Artifact;
    expect(parsed.claims[0]?.citations[0]?.quote).toBe("complete loss");
    expect(parsed.claims[0]?.citations[0]?.bboxes).toBeUndefined();
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
// buildBboxCache + reattachBboxes
// ---------------------------------------------------------------------------

describe("buildBboxCache + reattachBboxes", () => {
  test("roundtrip preserves bboxes by (paper_id, quote)", () => {
    const bbox = { page: 7, top: 10, left: 20, bottom: 30, right: 40 };
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
          citations: [{ quote: "q1", bboxes: [bbox] }],
        },
        {
          paper_id: "Jones2023",
          text: "c2",
          citations: [{ quote: "q2" }],
        },
      ],
    };
    const cache = buildBboxCache(JSON.stringify(original));
    const stripped: Artifact = {
      ...original,
      claims: original.claims.map((claim) => ({
        ...claim,
        citations: claim.citations.map(({ bboxes: _bboxes, ...rest }) => rest),
      })),
    };
    const reattached = reattachBboxes(stripped, cache);
    expect(reattached.claims[0]?.citations[0]?.bboxes).toEqual([bbox]);
    expect(reattached.claims[1]?.citations[0]?.bboxes).toBeUndefined();
  });

  test("citation with unknown (paper_id, quote) keeps no bboxes", () => {
    const cache = buildBboxCache(
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
                bboxes: [{ page: 1, top: 1, left: 1, bottom: 1, right: 1 }],
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
    const out = reattachBboxes(artifact, cache);
    expect(out.claims[0]?.citations[0]?.bboxes).toBeUndefined();
  });
});
