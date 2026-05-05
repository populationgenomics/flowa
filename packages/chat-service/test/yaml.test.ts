import { describe, expect, test } from "vitest";
import {
  addLineNumbers,
  artifactToYaml,
  buildBboxCache,
  insertAtLine,
  parseArtifactYaml,
  reattachBboxes,
  searchArtifact,
  viewRange,
} from "../src/yaml.js";
import type { Artifact } from "../src/artifact.js";

// 10-line YAML sample matching the citation-grounded artifact shape.
// yaml.ts is field-name-agnostic, but we use the canonical core fields so
// fixtures double as documentation.
const sample = [
  `category: cat-A`,
  `description: "Loss of function variant"`,
  `notes: |`,
  `  Summary line`,
  `  Evidence line`,
  `claims:`,
  `  - paper_id: Smith2024`,
  `    text: "complete loss"`,
  `  - paper_id: Jones2023`,
  `    text: "partial loss"`,
].join("\n");

// ---------------------------------------------------------------------------
// searchArtifact
// ---------------------------------------------------------------------------

describe("searchArtifact", () => {
  test("empty pattern returns zero", () => {
    const { output, count } = searchArtifact(sample, "");
    expect(count).toBe(0);
    expect(output).toBe("");
  });

  test("no matches returns zero", () => {
    const { output, count } = searchArtifact(sample, "nonexistent");
    expect(count).toBe(0);
    expect(output).toBe("");
  });

  test("single mid-file match includes one line of context each side", () => {
    const { output, count } = searchArtifact(sample, "description");
    expect(count).toBe(1);
    const lines = output.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^ 1\tcategory/);
    expect(lines[1]).toMatch(/^ 2\tdescription/);
    expect(lines[2]).toMatch(/^ 3\tnotes:/);
  });

  test("first-line match has no preceding context", () => {
    const { output, count } = searchArtifact(sample, `category: cat-A`);
    expect(count).toBe(1);
    const lines = output.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^ 1\tcategory:/);
    expect(lines[1]).toMatch(/^ 2\tdescription/);
  });

  test("last-line match has no following context", () => {
    const { output, count } = searchArtifact(sample, "partial loss");
    expect(count).toBe(1);
    const lines = output.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^ 9\t {2}- paper_id: Jones2023/);
    expect(lines[1]).toMatch(/^10\t {4}text: "partial loss"/);
  });

  test("overlapping context windows merge into a single block", () => {
    const { output, count } = searchArtifact(sample, "loss");
    expect(count).toBe(2);
    const blocks = output.split("\n--\n");
    expect(blocks).toHaveLength(1);
    // "loss" hits lines 8 and 10 → context [7,9] + [9,11→10] merge to [7,10] = 4 lines.
    expect(blocks[0]?.split("\n")).toHaveLength(4);
  });

  test("case-sensitive", () => {
    const { count } = searchArtifact(sample, "Loss");
    expect(count).toBe(1);
  });

  test("distant matches separated by --", () => {
    const text = [
      "alpha",
      "bravo",
      "charlie",
      "delta",
      "echo",
      "foxtrot",
      "alpha",
    ].join("\n");
    const { output, count } = searchArtifact(text, "alpha");
    expect(count).toBe(2);
    const blocks = output.split("\n--\n");
    expect(blocks).toHaveLength(2);
  });

  test("line numbers padded to file width", () => {
    const many = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join(
      "\n",
    );
    const { output } = searchArtifact(many, "line 5");
    expect(output).toMatch(/^ 4\tline 4$/m);
    expect(output).toMatch(/^ 5\tline 5$/m);
    expect(output).toMatch(/^ 6\tline 6$/m);
  });

  test("multiple hits on one line count as one match (line-hit semantics)", () => {
    const text = "foo foo foo\nbar\nfoo";
    const { count } = searchArtifact(text, "foo");
    expect(count).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// addLineNumbers
// ---------------------------------------------------------------------------

describe("addLineNumbers", () => {
  test("pads line numbers to total width", () => {
    const text = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join(
      "\n",
    );
    const out = addLineNumbers(text);
    const lines = out.split("\n");
    expect(lines[0]).toBe(" 1\tline 1");
    expect(lines[11]).toBe("12\tline 12");
  });

  test("single-line input", () => {
    expect(addLineNumbers("hello")).toBe("1\thello");
  });

  test("preserves empty lines", () => {
    expect(addLineNumbers("a\n\nb")).toBe("1\ta\n2\t\n3\tb");
  });
});

// ---------------------------------------------------------------------------
// viewRange
// ---------------------------------------------------------------------------

describe("viewRange", () => {
  const rangeSample = ["one", "two", "three", "four", "five"].join("\n");

  test("mid-file range", () => {
    const out = viewRange(rangeSample, 2, 4);
    const lines = out.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe("2\ttwo");
    expect(lines[1]).toBe("3\tthree");
    expect(lines[2]).toBe("4\tfour");
  });

  test("end=-1 means end of file", () => {
    const out = viewRange(rangeSample, 3, -1);
    const lines = out.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe("3\tthree");
    expect(lines[2]).toBe("5\tfive");
  });

  test("end past length clamps to length", () => {
    const out = viewRange(rangeSample, 4, 99);
    const lines = out.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe("5\tfive");
  });

  test("start below 1 clamps to 1", () => {
    const out = viewRange(rangeSample, 0, 2);
    const lines = out.split("\n");
    expect(lines[0]).toBe("1\tone");
    expect(lines[1]).toBe("2\ttwo");
  });

  test("start=end returns single line", () => {
    expect(viewRange(rangeSample, 3, 3)).toBe("3\tthree");
  });
});

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
