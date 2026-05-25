import { describe, expect, test } from "vitest";
import {
  addLineNumbers,
  searchLines,
  viewLineRange,
  viewLineRangeCapped,
} from "../src/text.js";

// 10-line YAML sample matching the citation-grounded artifact shape. text.ts
// is content-agnostic, but using canonical core fields keeps the fixtures
// readable.
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
// searchLines
// ---------------------------------------------------------------------------

describe("searchLines", () => {
  test("empty pattern returns zero", () => {
    const { output, count } = searchLines(sample, "");
    expect(count).toBe(0);
    expect(output).toBe("");
  });

  test("no matches returns zero", () => {
    const { output, count } = searchLines(sample, "nonexistent");
    expect(count).toBe(0);
    expect(output).toBe("");
  });

  test("single mid-file match includes one line of context each side", () => {
    const { output, count } = searchLines(sample, "description");
    expect(count).toBe(1);
    const lines = output.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^ 1\tcategory/);
    expect(lines[1]).toMatch(/^ 2\tdescription/);
    expect(lines[2]).toMatch(/^ 3\tnotes:/);
  });

  test("first-line match has no preceding context", () => {
    const { output, count } = searchLines(sample, `category: cat-A`);
    expect(count).toBe(1);
    const lines = output.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^ 1\tcategory:/);
    expect(lines[1]).toMatch(/^ 2\tdescription/);
  });

  test("last-line match has no following context", () => {
    const { output, count } = searchLines(sample, "partial loss");
    expect(count).toBe(1);
    const lines = output.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^ 9\t {2}- paper_id: Jones2023/);
    expect(lines[1]).toMatch(/^10\t {4}text: "partial loss"/);
  });

  test("overlapping context windows merge into a single block", () => {
    const { output, count } = searchLines(sample, "loss");
    expect(count).toBe(2);
    const blocks = output.split("\n--\n");
    expect(blocks).toHaveLength(1);
    // "loss" hits lines 8 and 10 → context [7,9] + [9,11→10] merge to [7,10] = 4 lines.
    expect(blocks[0]?.split("\n")).toHaveLength(4);
  });

  test("case-sensitive", () => {
    const { count } = searchLines(sample, "Loss");
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
    const { output, count } = searchLines(text, "alpha");
    expect(count).toBe(2);
    const blocks = output.split("\n--\n");
    expect(blocks).toHaveLength(2);
  });

  test("line numbers padded to file width", () => {
    const many = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join(
      "\n",
    );
    const { output } = searchLines(many, "line 5");
    expect(output).toMatch(/^ 4\tline 4$/m);
    expect(output).toMatch(/^ 5\tline 5$/m);
    expect(output).toMatch(/^ 6\tline 6$/m);
  });

  test("multiple hits on one line count as one match (line-hit semantics)", () => {
    const text = "foo foo foo\nbar\nfoo";
    const { count } = searchLines(text, "foo");
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
// viewLineRange
// ---------------------------------------------------------------------------

describe("viewLineRange", () => {
  const rangeSample = ["one", "two", "three", "four", "five"].join("\n");

  test("mid-file range", () => {
    const out = viewLineRange(rangeSample, 2, 4);
    const lines = out.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe("2\ttwo");
    expect(lines[1]).toBe("3\tthree");
    expect(lines[2]).toBe("4\tfour");
  });

  test("end=-1 means end of file", () => {
    const out = viewLineRange(rangeSample, 3, -1);
    const lines = out.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe("3\tthree");
    expect(lines[2]).toBe("5\tfive");
  });

  test("end past length clamps to length", () => {
    const out = viewLineRange(rangeSample, 4, 99);
    const lines = out.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe("5\tfive");
  });

  test("start below 1 clamps to 1", () => {
    const out = viewLineRange(rangeSample, 0, 2);
    const lines = out.split("\n");
    expect(lines[0]).toBe("1\tone");
    expect(lines[1]).toBe("2\ttwo");
  });

  test("start=end returns single line", () => {
    expect(viewLineRange(rangeSample, 3, 3)).toBe("3\tthree");
  });
});

// ---------------------------------------------------------------------------
// viewLineRangeCapped
// ---------------------------------------------------------------------------

describe("viewLineRangeCapped", () => {
  const rangeSample = ["one", "two", "three", "four", "five"].join("\n");

  test("range under cap returns full range, no notice", () => {
    const out = viewLineRangeCapped(rangeSample, 1, -1, 1000);
    expect(out).toBe(viewLineRange(rangeSample, 1, -1));
    expect(out).not.toMatch(/truncated/);
  });

  test("end=-1 means end of file", () => {
    const out = viewLineRangeCapped(rangeSample, 3, -1, 1000);
    expect(out).toBe(viewLineRange(rangeSample, 3, -1));
  });

  test("start below 1 clamps to 1", () => {
    const out = viewLineRangeCapped(rangeSample, 0, 2, 1000);
    expect(out).toBe(viewLineRange(rangeSample, 1, 2));
  });

  test("range over cap returns leading prefix plus truncation notice", () => {
    // 200 lines, each "line NNN" (~8 chars rendered with line number).
    const many = Array.from({ length: 200 }, (_, i) =>
      `line ${i + 1}`.padEnd(20, "x"),
    ).join("\n");
    // Cap small enough that only the first few lines fit alongside the notice.
    const out = viewLineRangeCapped(many, 1, -1, 250);

    expect(out).toMatch(/truncated/);
    // Notice names a cutoff line ≤ 200 and the upper bound 200.
    const m = out.match(
      /\[Output truncated at line (\d+) of (\d+) — request a narrower view_range or use searchPaper to locate specific passages\.\]/,
    );
    expect(m).not.toBeNull();
    const cutoff = parseInt(m![1]!, 10);
    const total = parseInt(m![2]!, 10);
    expect(total).toBe(200);
    expect(cutoff).toBeGreaterThan(0);
    expect(cutoff).toBeLessThan(200);

    // Output stays inside the cap.
    expect(out.length).toBeLessThanOrEqual(250);

    // The first included line precedes the notice.
    const lines = out.split("\n");
    expect(lines[0]).toMatch(/^ {2}1\tline 1/);
    expect(lines[lines.length - 1]).toMatch(/^\[Output truncated/);
  });

  test("cap larger than full output returns the full range unchanged", () => {
    const out = viewLineRangeCapped(rangeSample, 1, -1, 10_000);
    expect(out).toBe(viewLineRange(rangeSample, 1, -1));
  });

  test("narrow view_range within larger file is unaffected by cap", () => {
    const many = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join(
      "\n",
    );
    const out = viewLineRangeCapped(many, 50, 60, 100_000);
    const lines = out.split("\n");
    expect(lines).toHaveLength(11);
    expect(lines[0]).toBe("50\tline 50");
    expect(lines[10]).toBe("60\tline 60");
    expect(out).not.toMatch(/truncated/);
  });
});
